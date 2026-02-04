/**
 * Effect Tools Tests
 *
 * Tests for effect-related tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { globalToolRegistry } from '../ToolRegistry';
import {
  registerEffectTools,
  unregisterEffectTools,
  getEffectToolNames,
} from './effectTools';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('effectTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalToolRegistry.clear();
    registerEffectTools();
  });

  afterEach(() => {
    unregisterEffectTools();
  });

  describe('registration', () => {
    it('should register all effect tools', () => {
      expect(globalToolRegistry.has('add_effect')).toBe(true);
      expect(globalToolRegistry.has('remove_effect')).toBe(true);
      expect(globalToolRegistry.has('adjust_effect_param')).toBe(true);
      expect(globalToolRegistry.has('copy_effects')).toBe(true);
      expect(globalToolRegistry.has('reset_effects')).toBe(true);
    });

    it('should register tools in effect category', () => {
      const effectTools = globalToolRegistry.listByCategory('effect');
      expect(effectTools.length).toBe(5);
    });

    it('should return correct tool names', () => {
      const names = getEffectToolNames();
      expect(names).toContain('add_effect');
      expect(names).toContain('remove_effect');
      expect(names).toHaveLength(5);
    });

    it('should unregister all tools', () => {
      unregisterEffectTools();
      expect(globalToolRegistry.has('add_effect')).toBe(false);
      expect(globalToolRegistry.has('reset_effects')).toBe(false);
    });
  });

  describe('add_effect', () => {
    it('should execute IPC command', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_001', success: true });

      const result = await globalToolRegistry.execute('add_effect', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        effectType: 'blur',
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddEffect',
        payload: expect.objectContaining({
          effectType: 'blur',
        }),
      });
    });

    it('should support effect parameters', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_002', success: true });

      await globalToolRegistry.execute('add_effect', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        effectType: 'brightness',
        parameters: { value: 1.5 },
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddEffect',
        payload: expect.objectContaining({
          effectType: 'brightness',
          parameters: { value: 1.5 },
        }),
      });
    });
  });

  describe('remove_effect', () => {
    it('should execute with correct payload', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_003', success: true });

      await globalToolRegistry.execute('remove_effect', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        effectId: 'effect_001',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'RemoveEffect',
        payload: expect.objectContaining({
          effectId: 'effect_001',
        }),
      });
    });
  });

  describe('adjust_effect_param', () => {
    it('should adjust specific parameter', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_004', success: true });

      await globalToolRegistry.execute('adjust_effect_param', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        effectId: 'effect_001',
        paramName: 'intensity',
        paramValue: 0.75,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AdjustEffectParam',
        payload: expect.objectContaining({
          paramName: 'intensity',
          paramValue: 0.75,
        }),
      });
    });
  });

  describe('copy_effects', () => {
    it('should copy effects between clips', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_005', success: true });

      await globalToolRegistry.execute('copy_effects', {
        sequenceId: 'seq_001',
        sourceTrackId: 'track_001',
        sourceClipId: 'clip_001',
        targetTrackId: 'track_002',
        targetClipId: 'clip_002',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'CopyEffects',
        payload: expect.objectContaining({
          sourceClipId: 'clip_001',
          targetClipId: 'clip_002',
        }),
      });
    });
  });

  describe('reset_effects', () => {
    it('should remove all effects from clip', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_006', success: true });

      await globalToolRegistry.execute('reset_effects', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'ResetEffects',
        payload: expect.objectContaining({
          clipId: 'clip_001',
        }),
      });
    });
  });

  describe('error handling', () => {
    it('should return error on IPC failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Effect not found'));

      const result = await globalToolRegistry.execute('add_effect', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        effectType: 'blur',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Effect not found');
    });
  });
});

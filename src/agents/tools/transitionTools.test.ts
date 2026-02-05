/**
 * Transition Tools Tests
 *
 * Tests for transition-related tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { globalToolRegistry } from '../ToolRegistry';
import {
  registerTransitionTools,
  unregisterTransitionTools,
  getTransitionToolNames,
} from './transitionTools';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('transitionTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalToolRegistry.clear();
    registerTransitionTools();
  });

  afterEach(() => {
    unregisterTransitionTools();
  });

  describe('registration', () => {
    it('should register all transition tools', () => {
      expect(globalToolRegistry.has('add_transition')).toBe(true);
      expect(globalToolRegistry.has('remove_transition')).toBe(true);
      expect(globalToolRegistry.has('set_transition_duration')).toBe(true);
    });

    it('should register tools in transition category', () => {
      const transitionTools = globalToolRegistry.listByCategory('transition');
      expect(transitionTools.length).toBe(3);
    });

    it('should return correct tool names', () => {
      const names = getTransitionToolNames();
      expect(names).toContain('add_transition');
      expect(names).toContain('remove_transition');
      expect(names).toContain('set_transition_duration');
      expect(names).toHaveLength(3);
    });

    it('should unregister all tools', () => {
      unregisterTransitionTools();
      expect(globalToolRegistry.has('add_transition')).toBe(false);
      expect(globalToolRegistry.has('remove_transition')).toBe(false);
    });
  });

  describe('add_transition', () => {
    it('should add dissolve transition', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_001', success: true });

      const result = await globalToolRegistry.execute('add_transition', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        transitionType: 'dissolve',
        duration: 1.0,
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddTransition',
        payload: expect.objectContaining({
          transitionType: 'dissolve',
          duration: 1.0,
        }),
      });
    });

    it('should add wipe transition', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_002', success: true });

      await globalToolRegistry.execute('add_transition', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        transitionType: 'wipe',
        duration: 0.5,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddTransition',
        payload: expect.objectContaining({
          transitionType: 'wipe',
          duration: 0.5,
        }),
      });
    });

    it('should add fade transition', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_003', success: true });

      await globalToolRegistry.execute('add_transition', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        transitionType: 'fade',
        duration: 2.0,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddTransition',
        payload: expect.objectContaining({
          transitionType: 'fade',
        }),
      });
    });
  });

  describe('remove_transition', () => {
    it('should remove transition by ID', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_004', success: true });

      await globalToolRegistry.execute('remove_transition', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        transitionId: 'trans_001',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'RemoveTransition',
        payload: expect.objectContaining({
          transitionId: 'trans_001',
        }),
      });
    });
  });

  describe('set_transition_duration', () => {
    it('should update transition duration', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_005', success: true });

      await globalToolRegistry.execute('set_transition_duration', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        transitionId: 'trans_001',
        duration: 1.5,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'SetTransitionDuration',
        payload: expect.objectContaining({
          transitionId: 'trans_001',
          duration: 1.5,
        }),
      });
    });
  });

  describe('error handling', () => {
    it('should return error on IPC failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Transition failed'));

      const result = await globalToolRegistry.execute('add_transition', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        transitionType: 'dissolve',
        duration: 1.0,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Transition failed');
    });

    it('should handle invalid transition type gracefully', async () => {
      const result = await globalToolRegistry.execute('add_transition', {
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
        transitionType: 'invalid_type',
        duration: 1.0,
      });

      expect(result.success).toBe(false);
      // Schema validation catches invalid enum value
      expect(result.error).toContain('transitionType');
    });
  });
});

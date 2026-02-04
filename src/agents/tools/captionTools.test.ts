/**
 * Caption Tools Tests
 *
 * Tests for caption-related tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { globalToolRegistry } from '../ToolRegistry';
import {
  registerCaptionTools,
  unregisterCaptionTools,
  getCaptionToolNames,
} from './captionTools';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

const mockInvoke = vi.mocked(invoke);

describe('captionTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalToolRegistry.clear();
    registerCaptionTools();
  });

  afterEach(() => {
    unregisterCaptionTools();
  });

  describe('registration', () => {
    it('should register all caption tools', () => {
      expect(globalToolRegistry.has('add_caption')).toBe(true);
      expect(globalToolRegistry.has('update_caption')).toBe(true);
      expect(globalToolRegistry.has('delete_caption')).toBe(true);
      expect(globalToolRegistry.has('style_caption')).toBe(true);
    });

    it('should register tools in utility category', () => {
      const utilityTools = globalToolRegistry.listByCategory('utility');
      expect(utilityTools.length).toBe(4);
    });

    it('should return correct tool names', () => {
      const names = getCaptionToolNames();
      expect(names).toContain('add_caption');
      expect(names).toContain('update_caption');
      expect(names).toContain('delete_caption');
      expect(names).toContain('style_caption');
      expect(names).toHaveLength(4);
    });

    it('should unregister all tools', () => {
      unregisterCaptionTools();
      expect(globalToolRegistry.has('add_caption')).toBe(false);
      expect(globalToolRegistry.has('style_caption')).toBe(false);
    });
  });

  describe('add_caption', () => {
    it('should add caption with basic parameters', async () => {
      mockInvoke.mockResolvedValueOnce({
        opId: 'op_001',
        success: true,
        captionId: 'cap_001',
      });

      const result = await globalToolRegistry.execute('add_caption', {
        sequenceId: 'seq_001',
        text: 'Hello, world!',
        startTime: 0,
        endTime: 5,
      });

      expect(result.success).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddCaption',
        payload: expect.objectContaining({
          text: 'Hello, world!',
          startTime: 0,
          endTime: 5,
        }),
      });
    });

    it('should add caption with style', async () => {
      mockInvoke.mockResolvedValueOnce({
        opId: 'op_002',
        success: true,
        captionId: 'cap_002',
      });

      await globalToolRegistry.execute('add_caption', {
        sequenceId: 'seq_001',
        text: 'Styled caption',
        startTime: 10,
        endTime: 15,
        style: {
          fontSize: 24,
          color: '#FFFFFF',
          position: 'bottom',
        },
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddCaption',
        payload: expect.objectContaining({
          style: {
            fontSize: 24,
            color: '#FFFFFF',
            position: 'bottom',
          },
        }),
      });
    });
  });

  describe('update_caption', () => {
    it('should update caption text', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_003', success: true });

      await globalToolRegistry.execute('update_caption', {
        sequenceId: 'seq_001',
        captionId: 'cap_001',
        text: 'Updated text',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateCaption',
        payload: expect.objectContaining({
          captionId: 'cap_001',
          text: 'Updated text',
        }),
      });
    });

    it('should update caption timing', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_004', success: true });

      await globalToolRegistry.execute('update_caption', {
        sequenceId: 'seq_001',
        captionId: 'cap_001',
        text: 'Same text',
        startTime: 2,
        endTime: 8,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateCaption',
        payload: expect.objectContaining({
          startTime: 2,
          endTime: 8,
        }),
      });
    });
  });

  describe('delete_caption', () => {
    it('should delete caption by ID', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_005', success: true });

      await globalToolRegistry.execute('delete_caption', {
        sequenceId: 'seq_001',
        captionId: 'cap_001',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'DeleteCaption',
        payload: expect.objectContaining({
          captionId: 'cap_001',
        }),
      });
    });
  });

  describe('style_caption', () => {
    it('should update font size', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_006', success: true });

      await globalToolRegistry.execute('style_caption', {
        sequenceId: 'seq_001',
        captionId: 'cap_001',
        fontSize: 32,
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'StyleCaption',
        payload: expect.objectContaining({
          style: { fontSize: 32 },
        }),
      });
    });

    it('should update multiple style properties', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_007', success: true });

      await globalToolRegistry.execute('style_caption', {
        sequenceId: 'seq_001',
        captionId: 'cap_001',
        fontSize: 24,
        fontFamily: 'Arial',
        color: '#00FF00',
        backgroundColor: '#00000080',
        position: 'top',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'StyleCaption',
        payload: expect.objectContaining({
          style: {
            fontSize: 24,
            fontFamily: 'Arial',
            color: '#00FF00',
            backgroundColor: '#00000080',
            position: 'top',
          },
        }),
      });
    });

    it('should handle partial style updates', async () => {
      mockInvoke.mockResolvedValueOnce({ opId: 'op_008', success: true });

      await globalToolRegistry.execute('style_caption', {
        sequenceId: 'seq_001',
        captionId: 'cap_001',
        color: '#FF0000',
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'StyleCaption',
        payload: expect.objectContaining({
          style: { color: '#FF0000' },
        }),
      });
    });
  });

  describe('error handling', () => {
    it('should return error on IPC failure', async () => {
      mockInvoke.mockRejectedValueOnce(new Error('Caption not found'));

      const result = await globalToolRegistry.execute('update_caption', {
        sequenceId: 'seq_001',
        captionId: 'nonexistent_cap',
        text: 'New text',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Caption not found');
    });

    it('should handle invalid time range', async () => {
      mockInvoke.mockRejectedValueOnce(
        new Error('Invalid time range: startTime must be less than endTime')
      );

      const result = await globalToolRegistry.execute('add_caption', {
        sequenceId: 'seq_001',
        text: 'Bad timing',
        startTime: 10,
        endTime: 5,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid time range');
    });
  });
});

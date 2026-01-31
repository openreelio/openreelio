/**
 * useTextClip Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTextClip } from './useTextClip';
import { invoke } from '@tauri-apps/api/core';
import { createTextClipData, createTitleTextClipData } from '@/types';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock project store
const mockActiveSequenceId = 'seq-1';
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (selector: (state: { activeSequenceId: string | null }) => unknown) =>
    selector({ activeSequenceId: mockActiveSequenceId }),
}));

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('useTextClip', () => {
  const mockInvoke = vi.mocked(invoke);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addTextClip', () => {
    it('should add a text clip successfully', async () => {
      mockInvoke.mockResolvedValue({
        opId: 'op-1',
        createdIds: ['clip-1', 'effect-1'],
        deletedIds: [],
      });

      const { result } = renderHook(() => useTextClip());

      let clipId: string | undefined;
      await act(async () => {
        clipId = await result.current.addTextClip({
          trackId: 'video-track',
          timelineIn: 5.0,
          duration: 3.0,
          textData: createTextClipData('Hello World'),
        });
      });

      expect(clipId).toBe('clip-1');
      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddTextClip',
        payload: expect.objectContaining({
          sequenceId: mockActiveSequenceId,
          trackId: 'video-track',
          timelineIn: 5.0,
          duration: 3.0,
          textData: expect.objectContaining({
            content: 'Hello World',
          }),
        }),
      });
      expect(result.current.isAdding).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should add a title text clip', async () => {
      mockInvoke.mockResolvedValue({
        opId: 'op-1',
        createdIds: ['clip-1'],
        deletedIds: [],
      });

      const { result } = renderHook(() => useTextClip());

      await act(async () => {
        await result.current.addTextClip({
          trackId: 'overlay-track',
          timelineIn: 0.0,
          duration: 5.0,
          textData: createTitleTextClipData('Welcome'),
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'AddTextClip',
        payload: expect.objectContaining({
          textData: expect.objectContaining({
            content: 'Welcome',
            style: expect.objectContaining({
              fontSize: 72,
              bold: true,
            }),
          }),
        }),
      });
    });

    it('should handle add errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Track not found'));

      const { result } = renderHook(() => useTextClip());

      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.addTextClip({
            trackId: 'invalid-track',
            timelineIn: 0.0,
            duration: 5.0,
            textData: createTextClipData('Test'),
          });
        } catch (err) {
          thrown = err;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('Track not found');

      await waitFor(() => {
        expect(result.current.error).toBe('Track not found');
      });
      expect(result.current.isAdding).toBe(false);
    });

    it('should reject empty content', async () => {
      const { result } = renderHook(() => useTextClip());

      const emptyTextData = createTextClipData('');
      emptyTextData.content = '   ';

      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.addTextClip({
            trackId: 'video-track',
            timelineIn: 0.0,
            duration: 5.0,
            textData: emptyTextData,
          });
        } catch (err) {
          thrown = err;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('Text content cannot be empty');

      await waitFor(() => {
        expect(result.current.error).toBe('Text content cannot be empty');
      });
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should reject negative timeline position', async () => {
      const { result } = renderHook(() => useTextClip());

      await expect(
        act(async () => {
          await result.current.addTextClip({
            trackId: 'video-track',
            timelineIn: -1.0,
            duration: 5.0,
            textData: createTextClipData('Test'),
          });
        })
      ).rejects.toThrow('Timeline position cannot be negative');

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should reject zero duration', async () => {
      const { result } = renderHook(() => useTextClip());

      await expect(
        act(async () => {
          await result.current.addTextClip({
            trackId: 'video-track',
            timelineIn: 0.0,
            duration: 0,
            textData: createTextClipData('Test'),
          });
        })
      ).rejects.toThrow('Duration must be positive');

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should set isAdding while operation is in progress', async () => {
      let resolvePromise: (value: unknown) => void;
      mockInvoke.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = resolve;
          })
      );

      const { result } = renderHook(() => useTextClip());

      act(() => {
        result.current.addTextClip({
          trackId: 'video-track',
          timelineIn: 0.0,
          duration: 5.0,
          textData: createTextClipData('Test'),
        });
      });

      await waitFor(() => expect(result.current.isAdding).toBe(true));
      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        resolvePromise!({ opId: 'op-1', createdIds: ['clip-1'], deletedIds: [] });
      });

      await waitFor(() => expect(result.current.isAdding).toBe(false));
    });
  });

  describe('updateTextClip', () => {
    it('should update a text clip successfully', async () => {
      mockInvoke.mockResolvedValue({
        opId: 'op-1',
        createdIds: [],
        deletedIds: [],
      });

      const { result } = renderHook(() => useTextClip());

      await act(async () => {
        await result.current.updateTextClip({
          trackId: 'video-track',
          clipId: 'clip-1',
          textData: createTextClipData('Updated Text'),
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateTextClip',
        payload: expect.objectContaining({
          sequenceId: mockActiveSequenceId,
          trackId: 'video-track',
          clipId: 'clip-1',
          textData: expect.objectContaining({
            content: 'Updated Text',
          }),
        }),
      });
      expect(result.current.isUpdating).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should handle update errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Clip not found'));

      const { result } = renderHook(() => useTextClip());

      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.updateTextClip({
            trackId: 'video-track',
            clipId: 'invalid-clip',
            textData: createTextClipData('Test'),
          });
        } catch (err) {
          thrown = err;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('Clip not found');

      await waitFor(() => {
        expect(result.current.error).toBe('Clip not found');
      });
    });

    it('should reject empty content', async () => {
      const { result } = renderHook(() => useTextClip());

      const emptyTextData = createTextClipData('');

      await expect(
        act(async () => {
          await result.current.updateTextClip({
            trackId: 'video-track',
            clipId: 'clip-1',
            textData: emptyTextData,
          });
        })
      ).rejects.toThrow('Text content cannot be empty');

      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe('removeTextClip', () => {
    it('should remove a text clip successfully', async () => {
      mockInvoke.mockResolvedValue({
        opId: 'op-1',
        createdIds: [],
        deletedIds: ['clip-1'],
      });

      const { result } = renderHook(() => useTextClip());

      await act(async () => {
        await result.current.removeTextClip({
          trackId: 'video-track',
          clipId: 'clip-1',
        });
      });

      expect(mockInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'RemoveTextClip',
        payload: {
          sequenceId: mockActiveSequenceId,
          trackId: 'video-track',
          clipId: 'clip-1',
        },
      });
      expect(result.current.isRemoving).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should handle remove errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Clip is not a text clip'));

      const { result } = renderHook(() => useTextClip());

      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.removeTextClip({
            trackId: 'video-track',
            clipId: 'clip-1',
          });
        } catch (err) {
          thrown = err;
        }
      });

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('Clip is not a text clip');

      await waitFor(() => {
        expect(result.current.error).toBe('Clip is not a text clip');
      });
    });
  });

  describe('clearError', () => {
    it('should clear error state', async () => {
      mockInvoke.mockRejectedValue(new Error('Test error'));

      const { result } = renderHook(() => useTextClip());

      // Trigger an error
      let thrown: unknown;
      await act(async () => {
        try {
          await result.current.addTextClip({
            trackId: 'video-track',
            timelineIn: 0.0,
            duration: 5.0,
            textData: createTextClipData('Test'),
          });
        } catch (err) {
          thrown = err;
        }
      });

      expect(thrown).toBeInstanceOf(Error);

      await waitFor(() => {
        expect(result.current.error).toBe('Test error');
      });

      // Clear the error
      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('isLoading', () => {
    it('should reflect combined loading state', async () => {
      const { result } = renderHook(() => useTextClip());

      // Initially not loading
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isAdding).toBe(false);
      expect(result.current.isUpdating).toBe(false);
      expect(result.current.isRemoving).toBe(false);
    });
  });
});

describe('useTextClip with no active sequence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Override mock to return null sequence
    vi.doMock('@/stores/projectStore', () => ({
      useProjectStore: (selector: (state: { activeSequenceId: string | null }) => unknown) =>
        selector({ activeSequenceId: null }),
    }));
  });

  // Note: This test would need proper module reset to work correctly
  // Left as documentation of expected behavior
  it.skip('should reject operations when no sequence is active', async () => {
    // Test would verify that operations throw 'No active sequence' error
  });
});

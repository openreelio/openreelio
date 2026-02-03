/**
 * useBlendMode Hook Tests
 *
 * Tests for the blend mode management hook.
 * Following TDD methodology.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBlendMode } from './useBlendMode';

// Mock the project store
const mockExecuteCommand = vi.fn();
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: vi.fn((selector) => {
    const store = {
      executeCommand: mockExecuteCommand,
      getActiveSequence: vi.fn(() => ({
        id: 'seq-1',
        name: 'Test Sequence',
        tracks: [
          {
            id: 'track-1',
            kind: 'video',
            name: 'Video 1',
            clips: [],
            muted: false,
            locked: false,
            visible: true,
            volume: 1.0,
          },
          {
            id: 'track-2',
            kind: 'video',
            name: 'Video 2',
            clips: [],
            blendMode: 'multiply',
            muted: false,
            locked: false,
            visible: true,
            volume: 1.0,
          },
        ],
      })),
    };
    if (typeof selector === 'function') {
      return selector(store);
    }
    return store;
  }),
}));

describe('useBlendMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteCommand.mockResolvedValue({ opId: 'op-1', changes: [], createdIds: [], deletedIds: [] });
  });

  describe('getBlendMode', () => {
    it('should return current blend mode for a track', () => {
      const { result } = renderHook(() => useBlendMode());

      const blendMode = result.current.getBlendMode('track-1');
      expect(blendMode).toBe('normal');
    });

    it('should return different blend modes for different tracks', () => {
      const { result } = renderHook(() => useBlendMode());

      expect(result.current.getBlendMode('track-1')).toBe('normal');
      expect(result.current.getBlendMode('track-2')).toBe('multiply');
    });

    it('should return default blend mode for unknown track', () => {
      const { result } = renderHook(() => useBlendMode());

      const blendMode = result.current.getBlendMode('unknown-track');
      expect(blendMode).toBe('normal');
    });
  });

  describe('setBlendMode', () => {
    it('should call executeCommand with correct payload', async () => {
      const { result } = renderHook(() => useBlendMode());

      await act(async () => {
        await result.current.setBlendMode('track-1', 'multiply');
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'SetTrackBlendMode',
        payload: {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          blendMode: 'multiply',
        },
      });
    });

    it('should not call executeCommand if blend mode is the same', async () => {
      const { result } = renderHook(() => useBlendMode());

      await act(async () => {
        await result.current.setBlendMode('track-1', 'normal');
      });

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it('should return success result on valid change', async () => {
      const { result } = renderHook(() => useBlendMode());

      let success: boolean = false;
      await act(async () => {
        success = await result.current.setBlendMode('track-1', 'screen');
      });

      expect(success).toBe(true);
    });

    it('should return false on error', async () => {
      mockExecuteCommand.mockRejectedValue(new Error('Command failed'));
      const { result } = renderHook(() => useBlendMode());

      let success: boolean = true;
      await act(async () => {
        success = await result.current.setBlendMode('track-1', 'overlay');
      });

      expect(success).toBe(false);
    });
  });

  describe('isVideoTrack', () => {
    it('should return true for video tracks', () => {
      const { result } = renderHook(() => useBlendMode());

      expect(result.current.isVideoTrack('track-1')).toBe(true);
    });

    it('should return false for unknown tracks', () => {
      const { result } = renderHook(() => useBlendMode());

      expect(result.current.isVideoTrack('unknown')).toBe(false);
    });
  });

  describe('canChangeBlendMode', () => {
    it('should return true for unlocked video tracks', () => {
      const { result } = renderHook(() => useBlendMode());

      expect(result.current.canChangeBlendMode('track-1')).toBe(true);
    });

    it('should return false for unknown tracks', () => {
      const { result } = renderHook(() => useBlendMode());

      expect(result.current.canChangeBlendMode('unknown')).toBe(false);
    });
  });

  describe('getVideoTracks', () => {
    it('should return all video tracks with blend modes', () => {
      const { result } = renderHook(() => useBlendMode());

      const tracks = result.current.getVideoTracks();
      expect(tracks).toHaveLength(2);
      expect(tracks[0].id).toBe('track-1');
      expect(tracks[0].blendMode).toBe('normal');
      expect(tracks[1].id).toBe('track-2');
      expect(tracks[1].blendMode).toBe('multiply');
    });
  });

  describe('resetBlendMode', () => {
    it('should set blend mode to normal', async () => {
      const { result } = renderHook(() => useBlendMode());

      await act(async () => {
        await result.current.resetBlendMode('track-2');
      });

      expect(mockExecuteCommand).toHaveBeenCalledWith({
        type: 'SetTrackBlendMode',
        payload: {
          sequenceId: 'seq-1',
          trackId: 'track-2',
          blendMode: 'normal',
        },
      });
    });

    it('should not call command if already normal', async () => {
      const { result } = renderHook(() => useBlendMode());

      await act(async () => {
        await result.current.resetBlendMode('track-1');
      });

      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });
  });
});

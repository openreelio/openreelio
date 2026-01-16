/**
 * useTimelineActions Hook Tests
 *
 * TDD tests for timeline action callbacks connected to Tauri IPC commands.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useTimelineActions } from './useTimelineActions';
import { useProjectStore } from '@/stores';
import type { Sequence, Track, Clip, Asset } from '@/types';

// Mock Tauri
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `track_${Math.random().toString(36).substring(7)}`,
    name: 'Video 1',
    kind: 'video',
    clips: [],
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1.0,
    ...overrides,
  };
}

function createMockClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: `clip_${Math.random().toString(36).substring(7)}`,
    assetId: 'asset_001',
    range: {
      sourceInSec: 0,
      sourceOutSec: 10,
    },
    place: {
      timelineInSec: 0,
      durationSec: 10,
    },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    audio: {
      volumeDb: 0,
      pan: 0,
      muted: false,
    },
    speed: 1,
    opacity: 1,
    effects: [],
    label: undefined,
    color: undefined,
    ...overrides,
  };
}

function createMockSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: `seq_${Math.random().toString(36).substring(7)}`,
    name: 'Main Sequence',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [],
    markers: [],
    ...overrides,
  };
}

function createMockAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset_001',
    name: 'video.mp4',
    uri: '/path/to/video.mp4',
    kind: 'video',
    hash: 'abc123',
    fileSize: 1024000,
    importedAt: new Date().toISOString(),
    durationSec: 60,
    thumbnailUrl: undefined,
    proxyUrl: undefined,
    license: {
      source: 'user',
      licenseType: 'unknown',
      allowedUse: [],
    },
    tags: [],
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('useTimelineActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset projectStore
    useProjectStore.setState({
      isLoaded: true,
      isLoading: false,
      isDirty: false,
      meta: null,
      assets: new Map(),
      sequences: new Map(),
      activeSequenceId: null,
      selectedAssetId: null,
      error: null,
    });
  });

  // ===========================================================================
  // Asset Drop Tests
  // ===========================================================================

  describe('handleAssetDrop', () => {
    it('should execute InsertClip command when asset is dropped on timeline', async () => {
      const track = createMockTrack({ id: 'track_001' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

      // Setup mocks
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_001',
            createdIds: ['clip_001'],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleAssetDrop({
          assetId: 'asset_001',
          trackId: 'track_001',
          timelinePosition: 5.0,
        });
      });

      // Verify command was called with correct parameters
      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          assetId: 'asset_001',
          timelineIn: 5.0,
        },
      });
    });

    it('should not execute command when sequence is null', async () => {
      const { result } = renderHook(() => useTimelineActions({ sequence: null }));

      await act(async () => {
        await result.current.handleAssetDrop({
          assetId: 'asset_001',
          trackId: 'track_001',
          timelinePosition: 5.0,
        });
      });

      expect(mockedInvoke).not.toHaveBeenCalled();
    });

    it('should refresh project state after successful drop', async () => {
      const track = createMockTrack({ id: 'track_001' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });
      const asset = createMockAsset({ id: 'asset_001' });

      // Setup initial store state
      const assetsMap = new Map<string, Asset>();
      assetsMap.set(asset.id, asset);
      useProjectStore.setState({ assets: assetsMap });

      // Setup mocks
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_001',
            createdIds: ['clip_001'],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [asset],
            sequences: [
              {
                ...sequence,
                tracks: [
                  {
                    ...track,
                    clips: [createMockClip({ id: 'clip_001' })],
                  },
                ],
              },
            ],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleAssetDrop({
          assetId: 'asset_001',
          trackId: 'track_001',
          timelinePosition: 0,
        });
      });

      // Verify state refresh was called
      expect(mockedInvoke).toHaveBeenCalledWith('get_project_state');
    });
  });

  // ===========================================================================
  // Clip Move Tests
  // ===========================================================================

  describe('handleClipMove', () => {
    it('should execute MoveClip command with correct parameters', async () => {
      const clip = createMockClip({ id: 'clip_001' });
      const track = createMockTrack({ id: 'track_001', clips: [clip] });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_001',
            createdIds: [],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleClipMove({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newTimelineIn: 15.0,
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'MoveClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newTimelineIn: 15.0,
          newTrackId: undefined,
        },
      });
    });

    it('should support cross-track move with newTrackId', async () => {
      const clip = createMockClip({ id: 'clip_001' });
      const track1 = createMockTrack({ id: 'track_001', clips: [clip] });
      const track2 = createMockTrack({ id: 'track_002' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track1, track2],
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_001',
            createdIds: [],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleClipMove({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newTimelineIn: 10.0,
          newTrackId: 'track_002',
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'MoveClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newTimelineIn: 10.0,
          newTrackId: 'track_002',
        },
      });
    });
  });

  // ===========================================================================
  // Clip Trim Tests
  // ===========================================================================

  describe('handleClipTrim', () => {
    it('should execute TrimClip command for left trim', async () => {
      const clip = createMockClip({ id: 'clip_001' });
      const track = createMockTrack({ id: 'track_001', clips: [clip] });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_001',
            createdIds: [],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleClipTrim({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newSourceIn: 2.0,
          newTimelineIn: 2.0,
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'TrimClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newSourceIn: 2.0,
          newSourceOut: undefined,
          newTimelineIn: 2.0,
        },
      });
    });

    it('should execute TrimClip command for right trim', async () => {
      const clip = createMockClip({ id: 'clip_001' });
      const track = createMockTrack({ id: 'track_001', clips: [clip] });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_001',
            createdIds: [],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleClipTrim({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newSourceOut: 8.0,
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'TrimClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          newSourceIn: undefined,
          newSourceOut: 8.0,
          newTimelineIn: undefined,
        },
      });
    });
  });

  // ===========================================================================
  // Clip Split Tests
  // ===========================================================================

  describe('handleClipSplit', () => {
    it('should execute SplitClip command at given time', async () => {
      const clip = createMockClip({ id: 'clip_001' });
      const track = createMockTrack({ id: 'track_001', clips: [clip] });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_001',
            createdIds: ['clip_002'],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleClipSplit({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
          splitTime: 5.0,
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
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

  // ===========================================================================
  // Delete Clips Tests
  // ===========================================================================

  describe('handleDeleteClips', () => {
    it('should execute DeleteClip command for each selected clip', async () => {
      const clip1 = createMockClip({ id: 'clip_001' });
      const clip2 = createMockClip({ id: 'clip_002' });
      const track = createMockTrack({
        id: 'track_001',
        clips: [clip1, clip2],
      });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

      const executeCalls: Array<{ commandType: string; payload: unknown }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          executeCalls.push(args as { commandType: string; payload: unknown });
          return Promise.resolve({
            opId: 'op_001',
            createdIds: [],
            deletedIds: ['clip_001'],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleDeleteClips(['clip_001', 'clip_002']);
      });

      expect(executeCalls).toHaveLength(2);
      expect(executeCalls[0]).toEqual({
        commandType: 'DeleteClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_001',
        },
      });
      expect(executeCalls[1]).toEqual({
        commandType: 'DeleteClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          clipId: 'clip_002',
        },
      });
    });

    it('should not execute command when clipIds is empty', async () => {
      const track = createMockTrack({ id: 'track_001' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleDeleteClips([]);
      });

      expect(mockedInvoke).not.toHaveBeenCalled();
    });

    it('should handle clips on different tracks', async () => {
      const clip1 = createMockClip({ id: 'clip_001' });
      const clip2 = createMockClip({ id: 'clip_002' });
      const track1 = createMockTrack({
        id: 'track_001',
        clips: [clip1],
      });
      const track2 = createMockTrack({
        id: 'track_002',
        clips: [clip2],
      });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track1, track2],
      });

      const executeCalls: Array<{ commandType: string; payload: unknown }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          executeCalls.push(args as { commandType: string; payload: unknown });
          return Promise.resolve({
            opId: 'op_001',
            createdIds: [],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleDeleteClips(['clip_001', 'clip_002']);
      });

      expect(executeCalls).toHaveLength(2);
      expect(executeCalls[0].payload).toEqual({
        sequenceId: 'seq_001',
        trackId: 'track_001',
        clipId: 'clip_001',
      });
      expect(executeCalls[1].payload).toEqual({
        sequenceId: 'seq_001',
        trackId: 'track_002',
        clipId: 'clip_002',
      });
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should handle command execution error gracefully', async () => {
      const track = createMockTrack({ id: 'track_001' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockedInvoke.mockRejectedValue(new Error('Command failed'));

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      // Should not throw
      await act(async () => {
        await result.current.handleAssetDrop({
          assetId: 'asset_001',
          trackId: 'track_001',
          timelinePosition: 0,
        });
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to insert clip:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle state refresh error gracefully', async () => {
      const track = createMockTrack({ id: 'track_001' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_001',
            createdIds: ['clip_001'],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.reject(new Error('State refresh failed'));
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      // Should not throw even when refresh fails
      await act(async () => {
        await result.current.handleAssetDrop({
          assetId: 'asset_001',
          trackId: 'track_001',
          timelinePosition: 0,
        });
      });

      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });
});

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
import { _resetCommandQueueForTesting } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { probeMedia } from '@/utils/ffmpeg';
import type { Sequence, Track, Clip, Asset } from '@/types';

// Mock the logger - define mock fn inline to avoid hoisting issues
vi.mock('@/services/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock Tauri
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/utils/ffmpeg', () => ({
  probeMedia: vi.fn(),
}));

const workspaceStoreMocks = vi.hoisted(() => ({
  registerFile: vi.fn(),
}));

vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      registerFile: workspaceStoreMocks.registerFile,
    }),
  },
}));

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedProbeMedia = vi.mocked(probeMedia);

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
    proxyStatus: 'notNeeded',
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
    _resetCommandQueueForTesting();
    workspaceStoreMocks.registerFile.mockReset();
    mockedProbeMedia.mockResolvedValue({
      durationSec: 0,
      format: 'unknown',
      sizeBytes: 0,
      audio: undefined,
      video: undefined,
    });
    useTimelineStore.setState({ linkedSelectionEnabled: true });
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
  // Caption Update Tests
  // ===========================================================================

  describe('handleUpdateCaption', () => {
    it('should execute UpdateCaption command with correct parameters', async () => {
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [createMockTrack({ id: 'track_001' })],
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
        await result.current.handleUpdateCaption({
          sequenceId: 'seq_001',
          trackId: 'track_001',
          captionId: 'cap_001',
          text: 'Updated Text',
          style: { fontSize: 24 },
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'UpdateCaption',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          captionId: 'cap_001',
          text: 'Updated Text',
          style: { fontSize: 24 },
        },
      });
    });
  });

  // ===========================================================================
  // Clip Audio Update Tests
  // ===========================================================================

  describe('handleClipAudioUpdate', () => {
    it('should execute SetClipAudio command with updated clip audio fields', async () => {
      const clip = createMockClip({ id: 'clip_audio_001' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [createMockTrack({ id: 'track_a1', kind: 'audio', clips: [clip] })],
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_audio_001',
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
        await result.current.handleClipAudioUpdate({
          sequenceId: 'seq_001',
          trackId: 'track_a1',
          clipId: 'clip_audio_001',
          volumeDb: -6,
          fadeInSec: 1.25,
          fadeOutSec: 0.75,
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'SetClipAudio',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_a1',
          clipId: 'clip_audio_001',
          volumeDb: -6,
          fadeInSec: 1.25,
          fadeOutSec: 0.75,
        },
      });
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

    it('should register workspace file before inserting when dropped from files tab', async () => {
      const track = createMockTrack({ id: 'track_001' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });
      const workspaceAsset = createMockAsset({
        id: 'asset_workspace_001',
        kind: 'image',
        name: 'logo.png',
      });

      workspaceStoreMocks.registerFile.mockResolvedValue({
        assetId: 'asset_workspace_001',
        relativePath: 'images/logo.png',
        alreadyRegistered: false,
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_workspace_001',
            createdIds: ['clip_001'],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [workspaceAsset],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleAssetDrop({
          workspaceRelativePath: 'images/logo.png',
          assetKind: 'image',
          trackId: 'track_001',
          timelinePosition: 5,
        });
      });

      expect(workspaceStoreMocks.registerFile).toHaveBeenCalledWith('images/logo.png');
      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          assetId: 'asset_workspace_001',
          timelineIn: 5,
        },
      });
    });

    it('should re-register workspace file when drop payload has stale assetId', async () => {
      const track = createMockTrack({ id: 'track_001' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });
      const workspaceAsset = createMockAsset({
        id: 'asset_workspace_002',
        kind: 'image',
        name: 'stale-recovered.png',
      });

      workspaceStoreMocks.registerFile.mockResolvedValue({
        assetId: 'asset_workspace_002',
        relativePath: 'images/stale-recovered.png',
        alreadyRegistered: false,
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_workspace_002',
            createdIds: ['clip_002'],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [workspaceAsset],
            sequences: [sequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      await act(async () => {
        await result.current.handleAssetDrop({
          assetId: 'asset_stale_legacy',
          workspaceRelativePath: 'images/stale-recovered.png',
          assetKind: 'image',
          trackId: 'track_001',
          timelinePosition: 7,
        });
      });

      expect(workspaceStoreMocks.registerFile).toHaveBeenCalledWith('images/stale-recovered.png');
      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_001',
          assetId: 'asset_workspace_002',
          timelineIn: 7,
        },
      });
    });

    it('should insert linked audio to the first available audio track', async () => {
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

      useProjectStore.setState({
        assets: new Map([[asset.id, asset]]),
        sequences: new Map([[sequence.id, sequence]]),
      });

      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          const call = args as { commandType: string; payload: Record<string, unknown> };
          executeCalls.push(call);
          return Promise.resolve({
            opId: `op_${executeCalls.length}`,
            createdIds: [`clip_${executeCalls.length}`],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [asset],
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
          trackId: 'track_v1',
          timelinePosition: 3,
        });
      });

      expect(executeCalls).toHaveLength(3);
      expect(executeCalls[0]).toEqual({
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_v1',
          assetId: 'asset_001',
          timelineIn: 3,
        },
      });
      expect(executeCalls[2]).toEqual({
        commandType: 'SetClipMute',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_v1',
          clipId: 'clip_1',
          muted: true,
        },
      });
      expect(executeCalls[1]).toEqual({
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_a1',
          assetId: 'asset_001',
          timelineIn: 3,
        },
      });
    });

    it('should probe media for audio when metadata is missing and still split A/V by default', async () => {
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
      });

      mockedProbeMedia.mockResolvedValueOnce({
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

      useProjectStore.setState({
        assets: new Map([[asset.id, asset]]),
        sequences: new Map([[sequence.id, sequence]]),
      });

      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          const call = args as { commandType: string; payload: Record<string, unknown> };
          executeCalls.push(call);
          return Promise.resolve({
            opId: `op_${executeCalls.length}`,
            createdIds: [`clip_${executeCalls.length}`],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [asset],
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
          trackId: 'track_v1',
          timelinePosition: 3,
        });
      });

      expect(mockedProbeMedia).toHaveBeenCalledWith('/path/to/video.mp4');
      expect(executeCalls).toHaveLength(3);
      expect(executeCalls[1]).toEqual({
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_a1',
          assetId: 'asset_001',
          timelineIn: 3,
        },
      });
    });

    it('should route video drop on audio track to video lane and keep audio on audio lane', async () => {
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

      useProjectStore.setState({
        assets: new Map([[asset.id, asset]]),
        sequences: new Map([[sequence.id, sequence]]),
      });

      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          const call = args as { commandType: string; payload: Record<string, unknown> };
          executeCalls.push(call);
          return Promise.resolve({
            opId: `op_${executeCalls.length}`,
            createdIds: [`clip_${executeCalls.length}`],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [asset],
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
          trackId: 'track_a1',
          timelinePosition: 3,
        });
      });

      expect(executeCalls).toHaveLength(3);
      expect(executeCalls[0]).toEqual({
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_v1',
          assetId: 'asset_001',
          timelineIn: 3,
        },
      });
      expect(executeCalls[2]).toEqual({
        commandType: 'SetClipMute',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_v1',
          clipId: 'clip_1',
          muted: true,
        },
      });
      expect(executeCalls[1]).toEqual({
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_a1',
          assetId: 'asset_001',
          timelineIn: 3,
        },
      });
    });

    it('should create audio track before inserting linked audio when needed', async () => {
      const videoTrack = createMockTrack({ id: 'track_v1', kind: 'video', name: 'Video 1' });
      const baseSequence = createMockSequence({
        id: 'seq_001',
        tracks: [videoTrack],
      });
      const createdAudioTrack = createMockTrack({
        id: 'track_a1',
        kind: 'audio',
        name: 'Audio 1',
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

      let currentSequence = baseSequence;

      useProjectStore.setState({
        assets: new Map([[asset.id, asset]]),
        sequences: new Map([[baseSequence.id, baseSequence]]),
      });

      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          const call = args as { commandType: string; payload: Record<string, unknown> };
          executeCalls.push(call);

          if (call.commandType === 'CreateTrack') {
            currentSequence = {
              ...currentSequence,
              tracks: [...currentSequence.tracks, createdAudioTrack],
            };

            return Promise.resolve({
              opId: 'op_create_track',
              createdIds: ['track_a1'],
              deletedIds: [],
            });
          }

          return Promise.resolve({
            opId: `op_${executeCalls.length}`,
            createdIds: [`clip_${executeCalls.length}`],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [asset],
            sequences: [currentSequence],
            activeSequenceId: 'seq_001',
          });
        }
        return Promise.reject(new Error(`Unhandled: ${cmd}`));
      });

      const { result } = renderHook(() => useTimelineActions({ sequence: baseSequence }));

      await act(async () => {
        await result.current.handleAssetDrop({
          assetId: 'asset_001',
          trackId: 'track_v1',
          timelinePosition: 3,
        });
      });

      expect(executeCalls).toHaveLength(4);
      expect(executeCalls[0].commandType).toBe('InsertClip');
      expect(executeCalls[1]).toEqual({
        commandType: 'CreateTrack',
        payload: {
          sequenceId: 'seq_001',
          kind: 'audio',
          name: 'Audio 1',
          position: 1,
        },
      });
      expect(executeCalls[2]).toEqual({
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_a1',
          assetId: 'asset_001',
          timelineIn: 3,
        },
      });
      expect(executeCalls[3]).toEqual({
        commandType: 'SetClipMute',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_v1',
          clipId: 'clip_1',
          muted: true,
        },
      });
    });

    it('should select a non-overlapping audio track when extracting linked audio', async () => {
      const videoTrack = createMockTrack({ id: 'track_v1', kind: 'video', name: 'Video 1' });
      const busyAudioTrack = createMockTrack({
        id: 'track_a1',
        kind: 'audio',
        name: 'Audio 1',
        clips: [
          createMockClip({
            id: 'clip_busy',
            range: { sourceInSec: 0, sourceOutSec: 30 },
            place: { timelineInSec: 0, durationSec: 30 },
          }),
        ],
      });
      const openAudioTrack = createMockTrack({ id: 'track_a2', kind: 'audio', name: 'Audio 2' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [videoTrack, busyAudioTrack, openAudioTrack],
      });
      const asset = createMockAsset({
        id: 'asset_001',
        kind: 'video',
        durationSec: 10,
        audio: {
          sampleRate: 48000,
          channels: 2,
          codec: 'aac',
        },
      });

      useProjectStore.setState({
        assets: new Map([[asset.id, asset]]),
        sequences: new Map([[sequence.id, sequence]]),
      });

      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          const call = args as { commandType: string; payload: Record<string, unknown> };
          executeCalls.push(call);
          return Promise.resolve({
            opId: `op_${executeCalls.length}`,
            createdIds: [`clip_${executeCalls.length}`],
            deletedIds: [],
          });
        }
        if (cmd === 'get_project_state') {
          return Promise.resolve({
            assets: [asset],
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
          trackId: 'track_v1',
          timelinePosition: 5,
        });
      });

      expect(executeCalls).toHaveLength(3);
      expect(executeCalls[1]).toEqual({
        commandType: 'InsertClip',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_a2',
          assetId: 'asset_001',
          timelineIn: 5,
        },
      });
      expect(executeCalls[2]).toEqual({
        commandType: 'SetClipMute',
        payload: {
          sequenceId: 'seq_001',
          trackId: 'track_v1',
          clipId: 'clip_1',
          muted: true,
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
  // Track Create Tests
  // ===========================================================================

  describe('handleTrackCreate', () => {
    it('should execute CreateTrack for video lanes with generated name and top insertion', async () => {
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [
          createMockTrack({ id: 'track_v1', kind: 'video', name: 'Video 1' }),
          createMockTrack({ id: 'track_a1', kind: 'audio', name: 'Audio 1' }),
        ],
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_001',
            createdIds: ['track_v2'],
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
        await result.current.handleTrackCreate({
          sequenceId: 'seq_001',
          kind: 'video',
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'CreateTrack',
        payload: {
          sequenceId: 'seq_001',
          kind: 'video',
          name: 'Video 2',
          position: 0,
        },
      });
    });

    it('should append audio lanes after existing audio tracks', async () => {
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [
          createMockTrack({ id: 'track_v1', kind: 'video', name: 'Video 1' }),
          createMockTrack({ id: 'track_a1', kind: 'audio', name: 'Audio 1' }),
          createMockTrack({ id: 'track_a2', kind: 'audio', name: 'Audio 2' }),
        ],
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_002',
            createdIds: ['track_a3'],
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
        await result.current.handleTrackCreate({
          sequenceId: 'seq_001',
          kind: 'audio',
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'CreateTrack',
        payload: {
          sequenceId: 'seq_001',
          kind: 'audio',
          name: 'Audio 3',
          position: 3,
        },
      });
    });

    it('should respect explicit track name and insertion position overrides', async () => {
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [
          createMockTrack({ id: 'track_v1', kind: 'video', name: 'Video 1' }),
          createMockTrack({ id: 'track_a1', kind: 'audio', name: 'Audio 1' }),
        ],
      });

      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'execute_command') {
          return Promise.resolve({
            opId: 'op_003',
            createdIds: ['track_custom'],
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
        await result.current.handleTrackCreate({
          sequenceId: 'seq_001',
          kind: 'video',
          name: 'B-Roll Stack',
          position: 1,
        });
      });

      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', {
        commandType: 'CreateTrack',
        payload: {
          sequenceId: 'seq_001',
          kind: 'video',
          name: 'B-Roll Stack',
          position: 1,
        },
      });
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
  // Linked Selection Tests
  // ===========================================================================

  describe('linked selection operations', () => {
    it('should move linked companion clip when linked selection is enabled', async () => {
      const videoClip = createMockClip({
        id: 'clip_video_001',
        assetId: 'asset_linked_001',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const audioClip = createMockClip({
        id: 'clip_audio_001',
        assetId: 'asset_linked_001',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [
          createMockTrack({ id: 'track_v1', kind: 'video', clips: [videoClip] }),
          createMockTrack({ id: 'track_a1', kind: 'audio', clips: [audioClip] }),
        ],
      });

      useProjectStore.setState({ sequences: new Map([[sequence.id, sequence]]) });
      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          executeCalls.push(args as { commandType: string; payload: Record<string, unknown> });
          return Promise.resolve({ opId: 'op_001', createdIds: [], deletedIds: [] });
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
          trackId: 'track_v1',
          clipId: 'clip_video_001',
          newTimelineIn: 8,
        });
      });

      const moveCalls = executeCalls.filter((call) => call.commandType === 'MoveClip');
      expect(moveCalls).toHaveLength(2);
      expect(moveCalls[0].payload).toEqual({
        sequenceId: 'seq_001',
        trackId: 'track_v1',
        clipId: 'clip_video_001',
        newTimelineIn: 8,
        newTrackId: undefined,
      });
      expect(moveCalls[1].payload).toEqual({
        sequenceId: 'seq_001',
        trackId: 'track_a1',
        clipId: 'clip_audio_001',
        newTimelineIn: 8,
      });
    });

    it('should skip linked companion move when ignoreLinkedSelection is true', async () => {
      const videoClip = createMockClip({
        id: 'clip_video_001',
        assetId: 'asset_linked_001',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const audioClip = createMockClip({
        id: 'clip_audio_001',
        assetId: 'asset_linked_001',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [
          createMockTrack({ id: 'track_v1', kind: 'video', clips: [videoClip] }),
          createMockTrack({ id: 'track_a1', kind: 'audio', clips: [audioClip] }),
        ],
      });

      useProjectStore.setState({ sequences: new Map([[sequence.id, sequence]]) });
      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          executeCalls.push(args as { commandType: string; payload: Record<string, unknown> });
          return Promise.resolve({ opId: 'op_001', createdIds: [], deletedIds: [] });
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
          trackId: 'track_v1',
          clipId: 'clip_video_001',
          newTimelineIn: 8,
          ignoreLinkedSelection: true,
        });
      });

      const moveCalls = executeCalls.filter((call) => call.commandType === 'MoveClip');
      expect(moveCalls).toHaveLength(1);
    });

    it('should trim linked companion clip with matching delta', async () => {
      const videoClip = createMockClip({
        id: 'clip_video_001',
        assetId: 'asset_linked_001',
        range: { sourceInSec: 2, sourceOutSec: 12 },
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const audioClip = createMockClip({
        id: 'clip_audio_001',
        assetId: 'asset_linked_001',
        range: { sourceInSec: 2, sourceOutSec: 12 },
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [
          createMockTrack({ id: 'track_v1', kind: 'video', clips: [videoClip] }),
          createMockTrack({ id: 'track_a1', kind: 'audio', clips: [audioClip] }),
        ],
      });

      useProjectStore.setState({ sequences: new Map([[sequence.id, sequence]]) });
      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          executeCalls.push(args as { commandType: string; payload: Record<string, unknown> });
          return Promise.resolve({ opId: 'op_001', createdIds: [], deletedIds: [] });
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
          trackId: 'track_v1',
          clipId: 'clip_video_001',
          newSourceIn: 3,
          newTimelineIn: 6,
        });
      });

      const trimCalls = executeCalls.filter((call) => call.commandType === 'TrimClip');
      expect(trimCalls).toHaveLength(2);
      expect(trimCalls[1].payload).toEqual({
        sequenceId: 'seq_001',
        trackId: 'track_a1',
        clipId: 'clip_audio_001',
        newSourceIn: 3,
        newSourceOut: undefined,
        newTimelineIn: 6,
      });
    });

    it('should split linked companion clip at matching time', async () => {
      const videoClip = createMockClip({
        id: 'clip_video_001',
        assetId: 'asset_linked_001',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const audioClip = createMockClip({
        id: 'clip_audio_001',
        assetId: 'asset_linked_001',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [
          createMockTrack({ id: 'track_v1', kind: 'video', clips: [videoClip] }),
          createMockTrack({ id: 'track_a1', kind: 'audio', clips: [audioClip] }),
        ],
      });

      useProjectStore.setState({ sequences: new Map([[sequence.id, sequence]]) });
      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          executeCalls.push(args as { commandType: string; payload: Record<string, unknown> });
          return Promise.resolve({ opId: 'op_001', createdIds: [], deletedIds: [] });
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
          trackId: 'track_v1',
          clipId: 'clip_video_001',
          splitTime: 9,
        });
      });

      const splitCalls = executeCalls.filter((call) => call.commandType === 'SplitClip');
      expect(splitCalls).toHaveLength(2);
      expect(splitCalls[1].payload).toEqual({
        sequenceId: 'seq_001',
        trackId: 'track_a1',
        clipId: 'clip_audio_001',
        splitTime: 9,
      });
    });

    it('should delete linked companion clips when linked selection is enabled', async () => {
      const videoClip = createMockClip({
        id: 'clip_video_001',
        assetId: 'asset_linked_001',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const audioClip = createMockClip({
        id: 'clip_audio_001',
        assetId: 'asset_linked_001',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [
          createMockTrack({ id: 'track_v1', kind: 'video', clips: [videoClip] }),
          createMockTrack({ id: 'track_a1', kind: 'audio', clips: [audioClip] }),
        ],
      });

      useProjectStore.setState({ sequences: new Map([[sequence.id, sequence]]) });
      const executeCalls: Array<{ commandType: string; payload: Record<string, unknown> }> = [];

      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'execute_command') {
          executeCalls.push(args as { commandType: string; payload: Record<string, unknown> });
          return Promise.resolve({ opId: 'op_001', createdIds: [], deletedIds: [] });
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
        await result.current.handleDeleteClips(['clip_video_001']);
      });

      const deleteCalls = executeCalls.filter((call) => call.commandType === 'DeleteClip');
      expect(deleteCalls).toHaveLength(2);
      expect(deleteCalls).toEqual(
        expect.arrayContaining([
          {
            commandType: 'DeleteClip',
            payload: { sequenceId: 'seq_001', trackId: 'track_v1', clipId: 'clip_video_001' },
          },
          {
            commandType: 'DeleteClip',
            payload: { sequenceId: 'seq_001', trackId: 'track_a1', clipId: 'clip_audio_001' },
          },
        ]),
      );
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

      mockedInvoke.mockRejectedValue(new Error('Command failed'));

      const { result } = renderHook(() => useTimelineActions({ sequence }));

      // Should not throw - hook catches the error
      await act(async () => {
        await result.current.handleAssetDrop({
          assetId: 'asset_001',
          trackId: 'track_001',
          timelinePosition: 0,
        });
      });

      // The hook should have handled the error gracefully without crashing
      // The fact that we reach here without throwing confirms error handling works
      expect(mockedInvoke).toHaveBeenCalled();
    });

    it('should handle state refresh error gracefully', async () => {
      const track = createMockTrack({ id: 'track_001' });
      const sequence = createMockSequence({
        id: 'seq_001',
        tracks: [track],
      });

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

      // Hook handles refresh errors gracefully
      // The execute_command was called, and refresh error was caught
      expect(mockedInvoke).toHaveBeenCalledWith('execute_command', expect.any(Object));
    });
  });
});

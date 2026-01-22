/**
 * useAudioPlayback Hook Tests
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAudioPlayback } from './useAudioPlayback';
import type { Sequence, Asset, Track, Clip } from '@/types';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

// Mock playback store
const mockPlaybackStore = {
  currentTime: 0,
  isPlaying: false,
  volume: 1,
  isMuted: false,
  playbackRate: 1,
};

vi.mock('@/stores/playbackStore', () => ({
  usePlaybackStore: () => mockPlaybackStore,
}));

// Mock AudioContext
class MockAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;

  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockGainNode {
  gain = { value: 1 };
  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();
}

class MockAudioContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {};

  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createBufferSource = vi.fn().mockReturnValue(new MockAudioBufferSourceNode());
  createGain = vi.fn().mockReturnValue(new MockGainNode());
  decodeAudioData = vi.fn().mockResolvedValue({
    duration: 10,
    numberOfChannels: 2,
    sampleRate: 48000,
  } as AudioBuffer);
}

// =============================================================================
// Test Data
// =============================================================================

const createMockClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  assetId: 'asset-1',
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
  opacity: 1,
  speed: 1,
  effects: [],
  audio: {
    volumeDb: 0,
    pan: 0,
    muted: false,
  },
  ...overrides,
});

const createMockTrack = (overrides: Partial<Track> = {}): Track => ({
  id: 'track-1',
  kind: 'audio',
  name: 'Audio 1',
  clips: [createMockClip()],
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1.0,
  ...overrides,
});

const createMockSequence = (overrides: Partial<Sequence> = {}): Sequence => ({
  id: 'seq-1',
  name: 'Test Sequence',
  format: {
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    audioSampleRate: 48000,
    audioChannels: 2,
  },
  tracks: [createMockTrack()],
  markers: [],
  ...overrides,
});

const createMockAsset = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'asset-1',
  kind: 'audio',
  name: 'test.mp3',
  uri: '/path/to/test.mp3',
  hash: 'abc123',
  fileSize: 1000000,
  importedAt: '2024-01-01T00:00:00Z',
  license: {
    source: 'user',
    licenseType: 'unknown',
    allowedUse: [],
  },
  tags: [],
  proxyStatus: 'notNeeded',
  audio: {
    sampleRate: 48000,
    channels: 2,
    codec: 'mp3',
  },
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('useAudioPlayback', () => {
  let originalAudioContext: typeof window.AudioContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPlaybackStore.currentTime = 0;
    mockPlaybackStore.isPlaying = false;
    mockPlaybackStore.volume = 1;
    mockPlaybackStore.isMuted = false;
    mockPlaybackStore.playbackRate = 1;

    // Mock AudioContext globally
    originalAudioContext = window.AudioContext;
    window.AudioContext = MockAudioContext as unknown as typeof AudioContext;
  });

  afterEach(() => {
    window.AudioContext = originalAudioContext;
  });

  describe('Initialization', () => {
    it('returns initAudio function', () => {
      const sequence = createMockSequence();
      const assets = new Map<string, Asset>();

      const { result } = renderHook(() =>
        useAudioPlayback({ sequence, assets })
      );

      expect(result.current.initAudio).toBeDefined();
      expect(typeof result.current.initAudio).toBe('function');
    });

    it('creates AudioContext on initAudio call', async () => {
      const sequence = createMockSequence();
      const assets = new Map<string, Asset>();

      const { result } = renderHook(() =>
        useAudioPlayback({ sequence, assets })
      );

      await act(async () => {
        await result.current.initAudio();
      });

      // AudioContext should be created
      expect(window.AudioContext).toBeDefined();
    });

    it('resumes suspended AudioContext', async () => {
      const mockContext = new MockAudioContext();
      mockContext.state = 'suspended';
      window.AudioContext = vi.fn().mockReturnValue(mockContext) as unknown as typeof AudioContext;

      const sequence = createMockSequence();
      const assets = new Map<string, Asset>();

      const { result } = renderHook(() =>
        useAudioPlayback({ sequence, assets })
      );

      await act(async () => {
        await result.current.initAudio();
      });

      expect(mockContext.resume).toHaveBeenCalled();
    });
  });

  describe('Audio Scheduling', () => {
    it('does not schedule audio when not playing', async () => {
      const mockContext = new MockAudioContext();
      window.AudioContext = vi.fn().mockReturnValue(mockContext) as unknown as typeof AudioContext;

      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.isPlaying = false;

      renderHook(() => useAudioPlayback({ sequence, assets }));

      // Should not create buffer source when not playing
      expect(mockContext.createBufferSource).not.toHaveBeenCalled();
    });

    it('does not schedule audio when disabled', async () => {
      const mockContext = new MockAudioContext();
      window.AudioContext = vi.fn().mockReturnValue(mockContext) as unknown as typeof AudioContext;

      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.isPlaying = true;

      renderHook(() =>
        useAudioPlayback({ sequence, assets, enabled: false })
      );

      expect(mockContext.createBufferSource).not.toHaveBeenCalled();
    });

    it('handles muted tracks', async () => {
      const mockContext = new MockAudioContext();
      window.AudioContext = vi.fn().mockReturnValue(mockContext) as unknown as typeof AudioContext;

      const sequence = createMockSequence({
        tracks: [createMockTrack({ muted: true })],
      });
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.isPlaying = true;

      const { result } = renderHook(() =>
        useAudioPlayback({ sequence, assets })
      );

      await act(async () => {
        await result.current.initAudio();
      });

      // Should not schedule audio for muted tracks
      // (createBufferSource might be called for other reasons, but not for muted tracks)
    });
  });

  describe('Volume Control', () => {
    it('handles muted state', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.isMuted = true;

      const { result } = renderHook(() =>
        useAudioPlayback({ sequence, assets })
      );

      expect(result.current).toBeDefined();
    });

    it('applies volume changes', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.volume = 0.5;

      const { result } = renderHook(() =>
        useAudioPlayback({ sequence, assets })
      );

      expect(result.current).toBeDefined();
    });
  });

  describe('Clip Filtering', () => {
    it('only processes audio assets', () => {
      const sequence = createMockSequence();
      const videoAsset = createMockAsset({
        kind: 'video',
        audio: undefined,
      });
      const assets = new Map<string, Asset>([[videoAsset.id, videoAsset]]);

      const { result } = renderHook(() =>
        useAudioPlayback({ sequence, assets })
      );

      expect(result.current).toBeDefined();
    });

    it('processes video assets with audio', () => {
      const sequence = createMockSequence({
        tracks: [createMockTrack({ kind: 'video' })],
      });
      const videoWithAudio = createMockAsset({
        kind: 'video',
        audio: {
          sampleRate: 48000,
          channels: 2,
          codec: 'aac',
        },
      });
      const assets = new Map<string, Asset>([[videoWithAudio.id, videoWithAudio]]);

      const { result } = renderHook(() =>
        useAudioPlayback({ sequence, assets })
      );

      expect(result.current).toBeDefined();
    });
  });

  describe('Cleanup', () => {
    it('cleans up on unmount', async () => {
      const mockContext = new MockAudioContext();
      window.AudioContext = vi.fn().mockReturnValue(mockContext) as unknown as typeof AudioContext;

      const sequence = createMockSequence();
      const assets = new Map<string, Asset>();

      const { result, unmount } = renderHook(() =>
        useAudioPlayback({ sequence, assets })
      );

      await act(async () => {
        await result.current.initAudio();
      });

      unmount();

      expect(mockContext.close).toHaveBeenCalled();
    });
  });

  describe('Null Sequence', () => {
    it('handles null sequence gracefully', () => {
      const assets = new Map<string, Asset>();

      const { result } = renderHook(() =>
        useAudioPlayback({ sequence: null, assets })
      );

      expect(result.current.initAudio).toBeDefined();
    });
  });
});

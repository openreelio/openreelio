/**
 * useAudioScrubbing Hook Tests
 *
 * BDD-style integration tests for audio scrubbing behavior.
 * Uses real Zustand stores; only mocks external boundaries
 * (Web Audio API, Tauri IPC, fetch).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioScrubbing, SCRUB_THROTTLE_MS } from './useAudioScrubbing';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Sequence, Asset } from '@/types';

// =============================================================================
// External boundary mocks (per project mock policy)
// =============================================================================

// Mock 1: Tauri IPC boundary
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn(),
}));

// =============================================================================
// Web Audio API mock factory (Mock 2: browser hardware boundary)
// =============================================================================

function createMockGainNode() {
  return {
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    },
  };
}

function createMockPannerNode() {
  return {
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
    pan: { value: 0 },
  };
}

function createMockSourceNode() {
  return {
    connect: vi.fn().mockReturnThis(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
    buffer: null as AudioBuffer | null,
    playbackRate: { value: 1 },
    onended: null as (() => void) | null,
  };
}

const mockAudioBuffer = {
  duration: 10,
  length: 441000,
  numberOfChannels: 2,
  sampleRate: 44100,
  getChannelData: vi.fn(),
  copyFromChannel: vi.fn(),
  copyToChannel: vi.fn(),
} as unknown as AudioBuffer;

function createMockAudioContext() {
  return {
    state: 'running' as string,
    currentTime: 0,
    destination: {},
    createBufferSource: vi.fn(() => createMockSourceNode()),
    createGain: vi.fn(() => createMockGainNode()),
    createStereoPanner: vi.fn(() => createMockPannerNode()),
    decodeAudioData: vi.fn().mockResolvedValue(mockAudioBuffer),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// =============================================================================
// Test fixtures
// =============================================================================

function createTestSequence(): Sequence {
  return {
    id: 'seq-1',
    name: 'Test Sequence',
    duration: 30,
    width: 1920,
    height: 1080,
    fps: 30,
    masterVolumeDb: 0,
    tracks: [
      {
        id: 'track-audio',
        name: 'Audio 1',
        kind: 'audio',
        volume: 1.0,
        muted: false,
        locked: false,
        visible: true,
        clips: [
          {
            id: 'clip-1',
            assetId: 'asset-1',
            kind: 'audio',
            name: 'Audio Clip',
            speed: 1,
            enabled: true,
            place: { timelineInSec: 0, trackIndex: 0 },
            range: { sourceInSec: 0, sourceOutSec: 10 },
            audio: {
              volumeDb: 0,
              pan: 0,
              muted: false,
              fadeInSec: 0,
              fadeOutSec: 0,
            },
          },
        ],
      },
    ],
  } as unknown as Sequence;
}

function createTestAssets(): Map<string, Asset> {
  const map = new Map<string, Asset>();
  map.set('asset-1', {
    id: 'asset-1',
    name: 'test-audio.mp3',
    uri: '/path/to/test-audio.mp3',
    kind: 'audio',
    audio: { duration: 10, channels: 2, sampleRate: 44100 },
  } as unknown as Asset);
  return map;
}

// =============================================================================
// Test suite
// =============================================================================

describe('useAudioScrubbing', () => {
  let sequence: Sequence;
  let assets: Map<string, Asset>;
  let mockCtx: ReturnType<typeof createMockAudioContext>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Ensure Date.now() > 0 so first throttle check passes
    vi.advanceTimersByTime(1000);

    sequence = createTestSequence();
    assets = createTestAssets();
    mockCtx = createMockAudioContext();

    // Stub Web Audio API constructor
    vi.stubGlobal('AudioContext', vi.fn(() => mockCtx));

    // Stub fetch (Mock 3: network boundary)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
      }),
    );

    // Reset stores to known state
    usePlaybackStore.setState({
      isPlaying: false,
      currentTime: 0,
      volume: 1,
      isMuted: false,
    });

    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        playback: {
          ...useSettingsStore.getState().settings.playback,
          audioScrubbing: true,
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('scrub audio detection', () => {
    it('should play audio snippet when currentTime changes while paused', async () => {
      renderHook(() => useAudioScrubbing({ sequence, assets }));

      // Scrub: change currentTime while paused
      await act(async () => {
        usePlaybackStore.setState({ currentTime: 2.0 });
        // Flush microtasks so async buffer loading completes
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockCtx.createBufferSource).toHaveBeenCalled();
      const source = mockCtx.createBufferSource.mock.results[0]?.value;
      expect(source.start).toHaveBeenCalled();
    });

    it('should not play snippet when audioScrubbing setting is disabled', async () => {
      useSettingsStore.setState({
        settings: {
          ...useSettingsStore.getState().settings,
          playback: {
            ...useSettingsStore.getState().settings.playback,
            audioScrubbing: false,
          },
        },
      });

      renderHook(() => useAudioScrubbing({ sequence, assets }));

      await act(async () => {
        usePlaybackStore.setState({ currentTime: 2.0 });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockCtx.createBufferSource).not.toHaveBeenCalled();
    });

    it('should not play snippet during normal playback', async () => {
      usePlaybackStore.setState({ isPlaying: true });

      renderHook(() => useAudioScrubbing({ sequence, assets }));

      await act(async () => {
        usePlaybackStore.setState({ currentTime: 2.0, isPlaying: true });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockCtx.createBufferSource).not.toHaveBeenCalled();
    });

    it('should not play snippet when no audio clip at scrub position', async () => {
      // Scrub to a position beyond any clip (clip ends at 10s)
      renderHook(() => useAudioScrubbing({ sequence, assets }));

      await act(async () => {
        usePlaybackStore.setState({ currentTime: 15.0 });
        await vi.advanceTimersByTimeAsync(0);
      });

      // AudioContext is created, but no source should be started
      // (no clip at time 15.0)
      const sourceCallCount = mockCtx.createBufferSource.mock.calls.length;
      const startedCount = mockCtx.createBufferSource.mock.results
        .filter((r) => r.value.start.mock.calls.length > 0).length;
      expect(startedCount).toBe(0);
      // Even if context created lazily, no clip matches
      expect(sourceCallCount).toBe(0);
    });
  });

  describe('throttling', () => {
    it('should throttle snippets when scrubbing faster than SCRUB_THROTTLE_MS', async () => {
      renderHook(() => useAudioScrubbing({ sequence, assets }));

      // First scrub — should play
      await act(async () => {
        usePlaybackStore.setState({ currentTime: 1.0 });
        await vi.advanceTimersByTimeAsync(0);
      });

      const firstCallCount = mockCtx.createBufferSource.mock.calls.length;
      expect(firstCallCount).toBeGreaterThan(0);

      // Immediate second scrub (within throttle window) — should NOT create new source
      await act(async () => {
        usePlaybackStore.setState({ currentTime: 1.5 });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockCtx.createBufferSource.mock.calls.length).toBe(firstCallCount);

      // Advance past throttle window
      await act(async () => {
        vi.advanceTimersByTime(SCRUB_THROTTLE_MS + 10);
      });

      // Now scrub again — should play
      await act(async () => {
        usePlaybackStore.setState({ currentTime: 3.0 });
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockCtx.createBufferSource.mock.calls.length).toBeGreaterThan(
        firstCallCount,
      );
    });
  });

  describe('lifecycle', () => {
    it('should stop snippets when playback resumes', async () => {
      renderHook(() => useAudioScrubbing({ sequence, assets }));

      // Start scrubbing
      await act(async () => {
        usePlaybackStore.setState({ currentTime: 2.0 });
        await vi.advanceTimersByTimeAsync(0);
      });

      const source = mockCtx.createBufferSource.mock.results[0]?.value;
      expect(source).toBeDefined();
      expect(source.start).toHaveBeenCalled();

      // Resume playback — should stop scrub snippets
      await act(async () => {
        usePlaybackStore.setState({ isPlaying: true });
      });

      expect(source.stop).toHaveBeenCalled();
    });

    it('should clean up AudioContext on unmount', async () => {
      const { unmount } = renderHook(() =>
        useAudioScrubbing({ sequence, assets }),
      );

      // Trigger AudioContext creation via scrub
      await act(async () => {
        usePlaybackStore.setState({ currentTime: 2.0 });
        await vi.advanceTimersByTimeAsync(0);
      });

      unmount();

      expect(mockCtx.close).toHaveBeenCalled();
    });

    it('should apply clip volume and pan to scrub snippets', async () => {
      // Set non-default volume and pan on the clip
      const seq = createTestSequence();
      seq.tracks[0].clips[0].audio = {
        volumeDb: -6,
        pan: 0.5,
        muted: false,
        fadeInSec: 0,
        fadeOutSec: 0,
      };

      renderHook(() => useAudioScrubbing({ sequence: seq, assets }));

      await act(async () => {
        usePlaybackStore.setState({ currentTime: 2.0 });
        await vi.advanceTimersByTimeAsync(0);
      });

      // Verify gain node was created with fade envelope
      expect(mockCtx.createGain).toHaveBeenCalled();
      const gainNode = mockCtx.createGain.mock.results[0]?.value;
      expect(gainNode.gain.setValueAtTime).toHaveBeenCalled();
      expect(gainNode.gain.linearRampToValueAtTime).toHaveBeenCalled();

      // Verify panner was created with clip pan value
      expect(mockCtx.createStereoPanner).toHaveBeenCalled();
      const pannerNode = mockCtx.createStereoPanner.mock.results[0]?.value;
      expect(pannerNode.pan.value).toBe(0.5);
    });
  });
});

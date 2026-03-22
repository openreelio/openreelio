import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useAudioDucking } from './useAudioDucking';
import { useProjectStore, _resetCommandQueueForTesting } from '@/stores/projectStore';
import { refreshProjectState } from '@/utils/stateRefreshHelper';
import type { Clip, Sequence, Track } from '@/types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/utils/stateRefreshHelper', async () => {
  const actual = await vi.importActual<typeof import('@/utils/stateRefreshHelper')>(
    '@/utils/stateRefreshHelper',
  );

  return {
    ...actual,
    refreshProjectState: vi.fn(),
  };
});

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    range: { sourceInSec: 0, sourceOutSec: 10 },
    place: { timelineInSec: 0, durationSec: 10 },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false, volumeKeyframes: [] },
    ...overrides,
  };
}

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    kind: 'audio',
    name: 'Audio 1',
    clips: [createClip()],
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
    ...overrides,
  };
}

function createSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: 'seq-1',
    name: 'Sequence',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [createTrack()],
    markers: [],
    ...overrides,
  };
}

describe('useAudioDucking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCommandQueueForTesting();
    useProjectStore.setState({
      isLoaded: true,
      isLoading: false,
      isDirty: false,
      meta: null,
      assets: new Map(),
      sequences: new Map([['seq-1', createSequence()]]),
      activeSequenceId: 'seq-1',
      selectedAssetId: null,
      error: null,
      stateVersion: 0,
    });
  });

  it('should refresh project state and mark the store dirty when ducking succeeds', async () => {
    const updatedSequence = createSequence({
      tracks: [
        createTrack({
          clips: [
            createClip({
              audio: {
                volumeDb: 0,
                pan: 0,
                muted: false,
                volumeKeyframes: [
                  { timeOffset: 0, valueDb: 0, interpolation: 'linear' },
                  { timeOffset: 1, valueDb: -15, interpolation: 'linear' },
                ],
              },
            }),
          ],
        }),
      ],
    });

    vi.mocked(invoke).mockResolvedValue({
      opId: 'op-1',
      createdIds: [],
      deletedIds: [],
    });
    vi.mocked(refreshProjectState).mockResolvedValue({
      assets: new Map(),
      sequences: new Map([['seq-1', updatedSequence]]),
      activeSequenceId: 'seq-1',
    });

    const { result } = renderHook(() => useAudioDucking());

    let commandResult:
      | { opId: string; createdIds: string[]; deletedIds: string[] }
      | undefined;

    await act(async () => {
      commandResult = await result.current.applyDucking(
        'seq-1',
        'speech-track',
        'music-track',
        'music-clip',
      );
    });

    expect(invoke).toHaveBeenCalledWith('apply_audio_ducking', {
      args: {
        sequenceId: 'seq-1',
        speechTrackId: 'speech-track',
        musicTrackId: 'music-track',
        musicClipId: 'music-clip',
        params: {
          thresholdDb: -30,
          duckAmountDb: -15,
          attackMs: 200,
          releaseMs: 500,
        },
      },
    });
    expect(refreshProjectState).toHaveBeenCalledTimes(1);
    expect(commandResult).toEqual({
      opId: 'op-1',
      createdIds: [],
      deletedIds: [],
    });

    const storeState = useProjectStore.getState();
    expect(storeState.isDirty).toBe(true);
    expect(storeState.stateVersion).toBe(1);
    expect(storeState.error).toBeNull();
    expect(storeState.sequences.get('seq-1')).toEqual(updatedSequence);
    expect(result.current.error).toBeNull();
    expect(result.current.isApplying).toBe(false);
  });

  it('should store the error when ducking fails before state refresh', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('ducking failed'));

    const { result } = renderHook(() => useAudioDucking());

    await act(async () => {
      await expect(
        result.current.applyDucking('seq-1', 'speech-track', 'music-track', 'music-clip'),
      ).rejects.toThrow('ducking failed');
    });

    expect(refreshProjectState).not.toHaveBeenCalled();
    expect(result.current.error).toBe('ducking failed');
    expect(result.current.isApplying).toBe(false);
    expect(useProjectStore.getState().error).toBe('ducking failed');
    expect(useProjectStore.getState().stateVersion).toBe(0);
  });
});

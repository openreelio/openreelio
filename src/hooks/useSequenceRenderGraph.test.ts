import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderGraph } from '@/bindings';
import type { Clip, Sequence } from '@/types';
import { useProjectStore } from '@/stores/projectStore';
import { useSequenceRenderGraph } from './useSequenceRenderGraph';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock('@/services/framePaths', () => ({
  isTauriRuntime: runtimeMocks.isTauriRuntime,
}));

const mockedInvoke = vi.mocked(invoke);

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    range: { sourceInSec: 0, sourceOutSec: 5 },
    place: { timelineInSec: 0, durationSec: 5 },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
    ...overrides,
  };
}

function createSequence(clips: Clip[]): Sequence {
  return {
    id: 'seq-1',
    name: 'Sequence 1',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [
      {
        id: 'track-1',
        name: 'V1',
        kind: 'video',
        clips,
        blendMode: 'normal',
        muted: false,
        locked: false,
        visible: true,
        volume: 1,
      },
    ],
    markers: [],
  };
}

function createGraph(sequence: Sequence, clip: Clip): RenderGraph {
  return {
    graphVersion: 1,
    sequenceId: sequence.id,
    format: sequence.format,
    durationSec: 5,
    durationFrames: 150,
    visualLayers: [
      {
        layerIndex: 0,
        trackId: 'track-1',
        trackKind: 'video',
        trackIndex: 0,
        clipId: clip.id,
        timelineInSec: 0,
        timelineOutSec: 5,
        timelineInFrame: 0,
        timelineOutFrame: 150,
        durationFrames: 150,
        sourceInSec: 0,
        sourceOutSec: 5,
        sourceInFrame: 0,
        sourceOutFrame: 150,
        transform: clip.transform,
        opacity: 1,
        blendMode: 'normal',
        effects: [],
        source: { type: 'media', assetId: clip.assetId },
      },
    ],
    audioLayers: [],
  };
}

describe('useSequenceRenderGraph', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    runtimeMocks.isTauriRuntime.mockReturnValue(true);
    useProjectStore.setState({ stateVersion: 0 });
  });

  it('should fetch the render graph for a sequence', async () => {
    const clip = createClip();
    const sequence = createSequence([clip]);
    const graph = createGraph(sequence, clip);
    mockedInvoke.mockResolvedValue(graph);

    const { result } = renderHook(() => useSequenceRenderGraph(sequence));

    await waitFor(() => {
      expect(result.current?.sequenceId).toBe('seq-1');
    });

    expect(mockedInvoke).toHaveBeenCalledWith('get_sequence_render_graph', {
      sequenceId: 'seq-1',
    });
  });

  it('should skip invoke outside the Tauri runtime', async () => {
    runtimeMocks.isTauriRuntime.mockReturnValue(false);
    const sequence = createSequence([createClip()]);

    const { result } = renderHook(() => useSequenceRenderGraph(sequence));

    await waitFor(() => {
      expect(result.current).toBeNull();
    });

    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('should refetch when project state version changes', async () => {
    const clip = createClip();
    const sequence = createSequence([clip]);
    const initialGraph = createGraph(sequence, clip);
    const updatedGraph = {
      ...initialGraph,
      durationSec: 8,
    };
    mockedInvoke.mockResolvedValueOnce(initialGraph).mockResolvedValueOnce(updatedGraph);

    const { result } = renderHook(() => useSequenceRenderGraph(sequence));

    await waitFor(() => {
      expect(result.current?.durationSec).toBe(5);
    });

    act(() => {
      useProjectStore.setState((state) => ({ stateVersion: state.stateVersion + 1 }));
    });

    await waitFor(() => {
      expect(result.current?.durationSec).toBe(8);
    });

    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });
});

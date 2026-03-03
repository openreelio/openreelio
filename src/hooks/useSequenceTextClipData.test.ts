import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useSequenceTextClipData } from './useSequenceTextClipData';
import type { Clip, Sequence } from '@/types';
import { useProjectStore } from '@/stores/projectStore';

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

describe('useSequenceTextClipData', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    runtimeMocks.isTauriRuntime.mockReturnValue(true);
    useProjectStore.setState({ stateVersion: 0 });
  });

  it('should fetch and map text clip data when sequence contains text clips', async () => {
    const sequence = createSequence([createClip({ id: 'text-clip-1', assetId: '__text__title' })]);

    mockedInvoke.mockResolvedValue([
      {
        sequenceId: 'seq-1',
        trackId: 'track-1',
        clipId: 'text-clip-1',
        textData: {
          content: 'Resolved',
          style: {
            fontFamily: 'Arial',
            fontSize: 42,
            color: '#FFFFFF',
            alignment: 'center',
            bold: false,
            italic: false,
            underline: false,
            backgroundPadding: 10,
            lineHeight: 1.2,
            letterSpacing: 0,
          },
          position: { x: 0.5, y: 0.5 },
          rotation: 0,
          opacity: 1,
        },
      },
    ]);

    const { result } = renderHook(() => useSequenceTextClipData(sequence));

    await waitFor(() => {
      expect(result.current.get('text-clip-1')?.content).toBe('Resolved');
    });

    expect(mockedInvoke).toHaveBeenCalledWith('get_sequence_text_clip_data', {
      sequenceId: 'seq-1',
    });
  });

  it('should skip invoke when no text clips exist', async () => {
    const sequence = createSequence([createClip({ id: 'video-clip-1', assetId: 'asset-video-1' })]);
    const { result } = renderHook(() => useSequenceTextClipData(sequence));

    await waitFor(() => {
      expect(result.current.size).toBe(0);
    });

    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('should skip invoke outside tauri runtime', async () => {
    runtimeMocks.isTauriRuntime.mockReturnValue(false);
    const sequence = createSequence([createClip({ id: 'text-clip-1', assetId: '__text__title' })]);
    const { result } = renderHook(() => useSequenceTextClipData(sequence));

    await waitFor(() => {
      expect(result.current.size).toBe(0);
    });

    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it('should refetch when project state version changes', async () => {
    const sequence = createSequence([createClip({ id: 'text-clip-1', assetId: '__text__title' })]);

    mockedInvoke
      .mockResolvedValueOnce([
        {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'text-clip-1',
          textData: {
            content: 'Initial',
            style: {
              fontFamily: 'Arial',
              fontSize: 42,
              color: '#FFFFFF',
              alignment: 'center',
              bold: false,
              italic: false,
              underline: false,
              backgroundPadding: 10,
              lineHeight: 1.2,
              letterSpacing: 0,
            },
            position: { x: 0.5, y: 0.5 },
            rotation: 0,
            opacity: 1,
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          sequenceId: 'seq-1',
          trackId: 'track-1',
          clipId: 'text-clip-1',
          textData: {
            content: 'Updated',
            style: {
              fontFamily: 'Arial',
              fontSize: 42,
              color: '#FFFFFF',
              alignment: 'center',
              bold: false,
              italic: false,
              underline: false,
              backgroundPadding: 10,
              lineHeight: 1.2,
              letterSpacing: 0,
            },
            position: { x: 0.5, y: 0.5 },
            rotation: 0,
            opacity: 1,
          },
        },
      ]);

    const { result } = renderHook(() => useSequenceTextClipData(sequence));

    await waitFor(() => {
      expect(result.current.get('text-clip-1')?.content).toBe('Initial');
    });

    act(() => {
      useProjectStore.setState((state) => ({ stateVersion: state.stateVersion + 1 }));
    });

    await waitFor(() => {
      expect(result.current.get('text-clip-1')?.content).toBe('Updated');
    });

    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });
});

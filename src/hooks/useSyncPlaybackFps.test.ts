/**
 * useSyncPlaybackFps Hook Tests
 *
 * The playback controller's frame grid has to follow the active sequence, so
 * that a frame-accurate seek lands where the renderer would put it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSyncPlaybackFps } from './useSyncPlaybackFps';
import { playbackController } from '@/services/PlaybackController';
import { useProjectStore } from '@/stores/projectStore';
import type { Sequence } from '@/types';

function makeSequence(id: string, fpsNum: number, fpsDen: number): Sequence {
  return {
    id,
    name: id,
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: fpsNum, den: fpsDen },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [],
    markers: [],
  };
}

function activate(sequence: Sequence): void {
  useProjectStore.setState({
    sequences: new Map([[sequence.id, sequence]]),
    activeSequenceId: sequence.id,
  });
}

describe('useSyncPlaybackFps', () => {
  beforeEach(() => {
    useProjectStore.setState({ sequences: new Map(), activeSequenceId: null });
  });

  afterEach(() => {
    // The controller is a module singleton shared across the app.
    playbackController.setConfig({ fps: 30 });
  });

  it('should put the controller on the active sequence frame rate', () => {
    activate(makeSequence('seq_pal', 25, 1));

    renderHook(() => useSyncPlaybackFps());

    expect(playbackController.fps).toBe(25);
  });

  it('should snap to the sequence frame grid once synced', () => {
    activate(makeSequence('seq_pal', 25, 1));

    renderHook(() => useSyncPlaybackFps());

    // 0.045s is nearest to frame 1 at 25 fps (0.04s) and frame 1 at 30fps
    // would be 0.0333s, so the two grids disagree here.
    expect(playbackController.snapToFrame(0.045)).toBeCloseTo(0.04, 6);
  });

  it('should follow the rate when the active sequence changes', () => {
    activate(makeSequence('seq_pal', 25, 1));

    renderHook(() => useSyncPlaybackFps());
    act(() => {
      activate(makeSequence('seq_ntsc', 30000, 1001));
    });

    expect(playbackController.fps).toBeCloseTo(30000 / 1001, 6);
  });

  it('should fall back to 30 fps when no sequence is active', () => {
    playbackController.setConfig({ fps: 25 });

    renderHook(() => useSyncPlaybackFps());

    expect(playbackController.fps).toBe(30);
  });
});

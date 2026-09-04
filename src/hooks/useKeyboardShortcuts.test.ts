/**
 * useKeyboardShortcuts Hook Tests
 *
 * Integration tests using the real playback and project stores. Only the Tauri
 * IPC boundary is mocked (globally, in the test setup).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useProjectStore } from '@/stores/projectStore';
import { usePlaybackStore } from '@/stores/playbackStore';
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
    isLoaded: true,
  });
}

function pressKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    useProjectStore.setState({ sequences: new Map(), activeSequenceId: null, isLoaded: true });
    usePlaybackStore.setState({ currentTime: 0, duration: 120, isPlaying: false });
  });

  describe('frame stepping', () => {
    it('should advance one sequence frame when ArrowRight is pressed on a 25 fps sequence', () => {
      activate(makeSequence('seq_pal', 25, 1));
      renderHook(() => useKeyboardShortcuts());

      pressKey('ArrowRight');

      expect(usePlaybackStore.getState().currentTime).toBeCloseTo(1 / 25, 6);
    });

    it('should step back one sequence frame when ArrowLeft is pressed on a 25 fps sequence', () => {
      activate(makeSequence('seq_pal', 25, 1));
      usePlaybackStore.setState({ currentTime: 1 });
      renderHook(() => useKeyboardShortcuts());

      pressKey('ArrowLeft');

      expect(usePlaybackStore.getState().currentTime).toBeCloseTo(1 - 1 / 25, 6);
    });

    it('should advance one 30000/1001 frame on an NTSC sequence', () => {
      activate(makeSequence('seq_ntsc', 30000, 1001));
      renderHook(() => useKeyboardShortcuts());

      pressKey('ArrowRight');

      expect(usePlaybackStore.getState().currentTime).toBeCloseTo(1001 / 30000, 6);
    });

    it('should fall back to 30 fps when no sequence is active', () => {
      renderHook(() => useKeyboardShortcuts());

      pressKey('ArrowRight');

      expect(usePlaybackStore.getState().currentTime).toBeCloseTo(1 / 30, 6);
    });
  });
});

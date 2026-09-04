/**
 * useSequenceFps Hook Tests
 *
 * The frame rate every frame-based timeline control quantises to, read from the
 * sequence rather than assumed.
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useSequenceFps, resolveSequenceFps } from './useSequenceFps';
import { useProjectStore } from '@/stores/projectStore';
import type { Sequence } from '@/types';

function makeSequence(id: string, num: number, den: number): Sequence {
  return {
    id,
    name: id,
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num, den },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [],
    markers: [],
  };
}

describe('resolveSequenceFps', () => {
  it('should divide the ratio it is given', () => {
    expect(resolveSequenceFps({ num: 25, den: 1 })).toBe(25);
    expect(resolveSequenceFps({ num: 30000, den: 1001 })).toBeCloseTo(29.97, 4);
  });

  it('should fall back to 30 for a ratio that is not a usable rate', () => {
    expect(resolveSequenceFps(undefined)).toBe(30);
    expect(resolveSequenceFps(null)).toBe(30);
    expect(resolveSequenceFps({ num: 25, den: 0 })).toBe(30);
    expect(resolveSequenceFps({ num: 0, den: 1 })).toBe(30);
    expect(resolveSequenceFps({ num: -25, den: 1 })).toBe(30);
  });
});

describe('useSequenceFps', () => {
  beforeEach(() => {
    useProjectStore.setState({ sequences: new Map(), activeSequenceId: null });
  });

  it('should report the active sequence frame rate', () => {
    const pal = makeSequence('seq_pal', 25, 1);
    useProjectStore.setState({
      sequences: new Map([[pal.id, pal]]),
      activeSequenceId: pal.id,
    });

    const { result } = renderHook(() => useSequenceFps());

    expect(result.current).toBe(25);
  });

  it('should fall back to 30 when no sequence is active', () => {
    const { result } = renderHook(() => useSequenceFps());

    expect(result.current).toBe(30);
  });

  it('should prefer an explicitly passed sequence over the active one', () => {
    const active = makeSequence('seq_active', 30, 1);
    useProjectStore.setState({
      sequences: new Map([[active.id, active]]),
      activeSequenceId: active.id,
    });

    const { result } = renderHook(() => useSequenceFps(makeSequence('seq_other', 24, 1)));

    expect(result.current).toBe(24);
  });
});

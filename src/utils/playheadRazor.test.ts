import { describe, expect, it } from 'vitest';
import type { Clip, Sequence, Track } from '@/types';
import { getPlayheadRazorSplitTarget } from './playheadRazor';

function createClip(overrides: Partial<Clip> & { id: string }): Clip {
  const { id, ...rest } = overrides;

  return {
    id,
    assetId: 'asset_001',
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
    audio: { volumeDb: 0, pan: 0, muted: false },
    ...rest,
  };
}

function createTrack(overrides: Partial<Track> & { id: string; kind: Track['kind'] }): Track {
  const { id, kind, ...rest } = overrides;

  return {
    id,
    kind,
    name: id,
    clips: [],
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
    ...rest,
  };
}

function createSequence(tracks: Track[]): Sequence {
  return {
    id: 'seq_001',
    name: 'Sequence',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks,
    markers: [],
  };
}

describe('getPlayheadRazorSplitTarget', () => {
  it('returns the clip on the clicked track at the exact playhead time', () => {
    const sequence = createSequence([
      createTrack({
        id: 'track_v1',
        kind: 'video',
        clips: [createClip({ id: 'clip_001' })],
      }),
    ]);

    expect(getPlayheadRazorSplitTarget(sequence, 0, 4)).toEqual({
      trackId: 'track_v1',
      clipId: 'clip_001',
      splitTime: 4,
    });
  });

  it('returns null when the playhead is too close to a clip edge', () => {
    const sequence = createSequence([
      createTrack({
        id: 'track_v1',
        kind: 'video',
        clips: [createClip({ id: 'clip_001' })],
      }),
    ]);

    expect(getPlayheadRazorSplitTarget(sequence, 0, 0.05)).toBeNull();
    expect(getPlayheadRazorSplitTarget(sequence, 0, 9.95)).toBeNull();
  });

  it('returns null when there is no clip under the playhead on that track', () => {
    const sequence = createSequence([
      createTrack({
        id: 'track_v1',
        kind: 'video',
        clips: [createClip({ id: 'clip_001', place: { timelineInSec: 10, durationSec: 10 } })],
      }),
    ]);

    expect(getPlayheadRazorSplitTarget(sequence, 0, 4)).toBeNull();
  });
});

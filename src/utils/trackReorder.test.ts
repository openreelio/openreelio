import { describe, expect, it } from 'vitest';
import {
  buildTrackSwapOrder,
  getTrackSwapTargets,
  isProtectedBaseTrack,
  resolveTrackSwapTargetId,
} from './trackReorder';

const tracks = [
  { id: 'track_v1', kind: 'video', name: 'Video 1' },
  { id: 'track_v2', kind: 'video', name: 'Video 2' },
  { id: 'track_a1', kind: 'audio', name: 'Audio 1' },
] as const;

describe('trackReorder', () => {
  it('returns same-kind swap targets only', () => {
    expect(getTrackSwapTargets([...tracks], 'track_v1')).toEqual([
      { trackId: 'track_v2', name: 'Video 2' },
    ]);
  });

  it('builds a swapped order for tracks of the same kind', () => {
    expect(buildTrackSwapOrder([...tracks], 'track_v1', 'track_v2')).toEqual([
      'track_v2',
      'track_v1',
      'track_a1',
    ]);
  });

  it('rejects swaps across different track kinds', () => {
    expect(buildTrackSwapOrder([...tracks], 'track_v1', 'track_a1')).toBeNull();
    expect(resolveTrackSwapTargetId([...tracks], 'track_v1', 2)).toBe('track_a1');
  });

  it('protects explicit base tracks from deletion', () => {
    expect(
      isProtectedBaseTrack(
        [
          { id: 'track_v1', kind: 'video', isBaseTrack: true },
          { id: 'track_v2', kind: 'video', isBaseTrack: false },
          { id: 'track_a1', kind: 'audio', isBaseTrack: true },
        ],
        'track_v1',
      ),
    ).toBe(true);
    expect(
      isProtectedBaseTrack(
        [
          { id: 'track_v1', kind: 'video', isBaseTrack: true },
          { id: 'track_v2', kind: 'video', isBaseTrack: false },
          { id: 'track_a1', kind: 'audio', isBaseTrack: true },
        ],
        'track_v2',
      ),
    ).toBe(false);
  });

  it('falls back to protecting the earliest legacy video/audio track', () => {
    expect(
      isProtectedBaseTrack(
        [
          { id: '01LEGACYVIDEO', kind: 'video' },
          { id: '02LEGACYVIDEO', kind: 'video' },
          { id: '01LEGACYAUDIO', kind: 'audio' },
        ],
        '01LEGACYVIDEO',
      ),
    ).toBe(true);
    expect(
      isProtectedBaseTrack(
        [
          { id: '01LEGACYVIDEO', kind: 'video' },
          { id: '02LEGACYVIDEO', kind: 'video' },
          { id: '01LEGACYAUDIO', kind: 'audio' },
        ],
        '02LEGACYVIDEO',
      ),
    ).toBe(false);
  });

  it('keeps protecting legacy base tracks even after newer tracks get explicit metadata', () => {
    expect(
      isProtectedBaseTrack(
        [
          { id: '01LEGACYVIDEO', kind: 'video' },
          { id: '02ADDEDVIDEO', kind: 'video', isBaseTrack: false },
          { id: '01LEGACYAUDIO', kind: 'audio' },
        ],
        '01LEGACYVIDEO',
      ),
    ).toBe(true);
  });
});

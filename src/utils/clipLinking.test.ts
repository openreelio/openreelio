import { describe, expect, it } from 'vitest';
import type { Clip, Sequence, Track } from '@/types';
import {
  buildLinkedMoveTargets,
  buildLinkedTrimTargets,
  expandClipIdsWithLinkedCompanions,
  findLinkedCompanionClipIds,
  getLinkedSplitTargets,
} from './clipLinking';

function createClip(overrides: Partial<Clip> & { id: string; assetId: string }): Clip {
  const { id, assetId, ...rest } = overrides;

  return {
    id,
    assetId,
    range: { sourceInSec: 0, sourceOutSec: 10 },
    place: { timelineInSec: 10, durationSec: 10 },
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
    name: kind === 'audio' ? 'Audio' : 'Video',
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
    id: 'seq-1',
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

describe('clipLinking utilities', () => {
  it('finds linked companion clips across video/audio tracks', () => {
    const sequence = createSequence([
      createTrack({
        id: 'video-track',
        kind: 'video',
        clips: [createClip({ id: 'video-clip', assetId: 'asset-1' })],
      }),
      createTrack({
        id: 'audio-track',
        kind: 'audio',
        clips: [createClip({ id: 'audio-clip', assetId: 'asset-1' })],
      }),
    ]);

    expect(findLinkedCompanionClipIds(sequence, 'video-clip')).toEqual(['audio-clip']);
    expect(findLinkedCompanionClipIds(sequence, 'audio-clip')).toEqual(['video-clip']);
  });

  it('expands clip selections with linked companions', () => {
    const sequence = createSequence([
      createTrack({
        id: 'video-track',
        kind: 'video',
        clips: [createClip({ id: 'video-clip', assetId: 'asset-1' })],
      }),
      createTrack({
        id: 'audio-track',
        kind: 'audio',
        clips: [createClip({ id: 'audio-clip', assetId: 'asset-1' })],
      }),
    ]);

    expect(expandClipIdsWithLinkedCompanions(sequence, ['video-clip'])).toEqual([
      'video-clip',
      'audio-clip',
    ]);
  });

  it('builds linked move targets preserving timeline offset', () => {
    const sequence = createSequence([
      createTrack({
        id: 'video-track',
        kind: 'video',
        clips: [
          createClip({
            id: 'video-clip',
            assetId: 'asset-1',
            place: { timelineInSec: 10, durationSec: 10 },
          }),
        ],
      }),
      createTrack({
        id: 'audio-track',
        kind: 'audio',
        clips: [
          createClip({
            id: 'audio-clip',
            assetId: 'asset-1',
            place: { timelineInSec: 10, durationSec: 10 },
          }),
        ],
      }),
    ]);

    expect(buildLinkedMoveTargets(sequence, 'video-clip', 22)).toEqual([
      {
        clipId: 'audio-clip',
        trackId: 'audio-track',
        newTimelineIn: 22,
      },
    ]);
  });

  it('builds linked trim targets with matching deltas', () => {
    const sequence = createSequence([
      createTrack({
        id: 'video-track',
        kind: 'video',
        clips: [createClip({ id: 'video-clip', assetId: 'asset-1' })],
      }),
      createTrack({
        id: 'audio-track',
        kind: 'audio',
        clips: [createClip({ id: 'audio-clip', assetId: 'asset-1' })],
      }),
    ]);

    expect(
      buildLinkedTrimTargets(sequence, {
        sequenceId: 'seq-1',
        trackId: 'video-track',
        clipId: 'video-clip',
        newSourceIn: 2,
        newTimelineIn: 12,
      }),
    ).toEqual([
      {
        sequenceId: 'seq-1',
        trackId: 'audio-track',
        clipId: 'audio-clip',
        newSourceIn: 2,
        newTimelineIn: 12,
      },
    ]);
  });

  it('returns linked split targets that contain split time', () => {
    const sequence = createSequence([
      createTrack({
        id: 'video-track',
        kind: 'video',
        clips: [createClip({ id: 'video-clip', assetId: 'asset-1' })],
      }),
      createTrack({
        id: 'audio-track',
        kind: 'audio',
        clips: [createClip({ id: 'audio-clip', assetId: 'asset-1' })],
      }),
    ]);

    expect(getLinkedSplitTargets(sequence, 'video-clip', 12)).toEqual([
      {
        clipId: 'audio-clip',
        trackId: 'audio-track',
      },
    ]);
    expect(getLinkedSplitTargets(sequence, 'video-clip', 25)).toEqual([]);
  });
});

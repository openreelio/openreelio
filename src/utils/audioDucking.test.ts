import { describe, expect, it } from 'vitest';
import type { Clip, Sequence, Track } from '@/types';
import { resolveAutoDuckTargets } from './audioDucking';

function createClip(id: string): Clip {
  return {
    id,
    assetId: `${id}-asset`,
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
  };
}

function createTrack(id: string, clips: Clip[]): Track {
  return {
    id,
    kind: 'audio',
    name: id,
    clips,
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
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

describe('resolveAutoDuckTargets', () => {
  it('should resolve speech and music targets automatically for a simple two-track sequence', () => {
    const sequence = createSequence([
      createTrack('speech-track', [createClip('speech-clip')]),
      createTrack('music-track', [createClip('music-clip')]),
    ]);

    expect(resolveAutoDuckTargets(sequence, [])).toEqual({
      ok: true,
      targets: {
        speechTrackId: 'speech-track',
        musicTrackId: 'music-track',
        musicClipId: 'music-clip',
      },
    });
  });

  it('should prefer a selected audio clip as the music target when the setup is unambiguous', () => {
    const sequence = createSequence([
      createTrack('speech-track', [createClip('speech-clip')]),
      createTrack('music-track', [createClip('music-a'), createClip('music-b')]),
    ]);

    expect(resolveAutoDuckTargets(sequence, ['music-b'])).toEqual({
      ok: true,
      targets: {
        speechTrackId: 'speech-track',
        musicTrackId: 'music-track',
        musicClipId: 'music-b',
      },
    });
  });

  it('should reject ambiguous multi-track setups when no music clip is selected', () => {
    const sequence = createSequence([
      createTrack('speech-track', [createClip('speech-clip')]),
      createTrack('music-track', [createClip('music-clip')]),
      createTrack('ambience-track', [createClip('ambience-clip')]),
    ]);

    expect(resolveAutoDuckTargets(sequence, [])).toEqual({
      ok: false,
      reason: 'Select the music clip to duck when multiple audio tracks contain clips.',
    });
  });

  it('should reject a selected music clip when multiple speech-track candidates remain', () => {
    const sequence = createSequence([
      createTrack('speech-track', [createClip('speech-clip')]),
      createTrack('music-track', [createClip('music-clip')]),
      createTrack('ambience-track', [createClip('ambience-clip')]),
    ]);

    expect(resolveAutoDuckTargets(sequence, ['music-clip'])).toEqual({
      ok: false,
      reason:
        'Auto-duck is ambiguous with multiple speech-track candidates. Select a music clip in a two-track audio setup.',
    });
  });
});

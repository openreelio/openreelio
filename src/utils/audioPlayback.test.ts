import { describe, expect, it } from 'vitest';
import { assetHasPlayableAudio, collectPlaybackAudioClips } from './audioPlayback';
import type { Asset, Clip, Sequence, Track } from '@/types';

function createAsset(overrides: Partial<Asset> & { id: string }): Asset {
  const { id, ...rest } = overrides;

  return {
    id,
    kind: 'video',
    name: 'asset.mp4',
    uri: '/asset.mp4',
    hash: 'hash',
    fileSize: 1024,
    importedAt: new Date().toISOString(),
    durationSec: 10,
    proxyStatus: 'notNeeded',
    license: {
      source: 'user',
      licenseType: 'unknown',
      allowedUse: [],
    },
    tags: [],
    ...rest,
  };
}

function createClip(overrides: Partial<Clip> & { id: string; assetId: string }): Clip {
  const { id, assetId, ...rest } = overrides;

  return {
    id,
    assetId,
    range: {
      sourceInSec: 0,
      sourceOutSec: 10,
    },
    place: {
      timelineInSec: 0,
      durationSec: 10,
    },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: {
      volumeDb: 0,
      pan: 0,
      muted: false,
    },
    ...rest,
  };
}

function createTrack(overrides: Partial<Track> & { id: string; kind: Track['kind'] }): Track {
  const { id, kind, ...rest } = overrides;

  return {
    id,
    kind,
    name: kind === 'audio' ? 'Audio 1' : 'Video 1',
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

describe('assetHasPlayableAudio', () => {
  it('returns true for audio and video-with-audio assets', () => {
    const audioAsset = createAsset({ id: 'a1', kind: 'audio' });
    const videoWithAudio = createAsset({
      id: 'v1',
      kind: 'video',
      audio: { sampleRate: 48000, channels: 2, codec: 'aac' },
    });

    expect(assetHasPlayableAudio(audioAsset)).toBe(true);
    expect(assetHasPlayableAudio(videoWithAudio)).toBe(true);
  });

  it('returns false for assets without audio streams', () => {
    const silentVideo = createAsset({ id: 'v2', kind: 'video', audio: undefined });
    const image = createAsset({ id: 'i1', kind: 'image' });

    expect(assetHasPlayableAudio(silentVideo)).toBe(false);
    expect(assetHasPlayableAudio(image)).toBe(false);
  });
});

describe('collectPlaybackAudioClips', () => {
  it('collects audio-capable clips from unmuted tracks', () => {
    const videoAsset = createAsset({
      id: 'video-asset',
      kind: 'video',
      audio: { sampleRate: 48000, channels: 2, codec: 'aac' },
    });
    const audioAsset = createAsset({ id: 'audio-asset', kind: 'audio' });

    const sequence = createSequence([
      createTrack({
        id: 'video-track',
        kind: 'video',
        clips: [createClip({ id: 'video-clip', assetId: 'video-asset' })],
      }),
      createTrack({
        id: 'audio-track',
        kind: 'audio',
        clips: [createClip({ id: 'audio-clip', assetId: 'audio-asset' })],
      }),
    ]);

    const result = collectPlaybackAudioClips(
      sequence,
      new Map([
        [videoAsset.id, videoAsset],
        [audioAsset.id, audioAsset],
      ]),
    );

    expect(result.map((entry) => entry.clip.id)).toEqual(['video-clip', 'audio-clip']);
  });

  it('suppresses video-track audio when a matching audio companion exists', () => {
    const videoAsset = createAsset({
      id: 'video-asset',
      kind: 'video',
      audio: { sampleRate: 48000, channels: 2, codec: 'aac' },
    });

    const matchedVideoClip = createClip({
      id: 'video-clip',
      assetId: 'video-asset',
      range: { sourceInSec: 1, sourceOutSec: 6 },
      place: { timelineInSec: 10, durationSec: 5 },
      speed: 1,
    });
    const matchedAudioClip = createClip({
      id: 'audio-clip',
      assetId: 'video-asset',
      range: { sourceInSec: 1, sourceOutSec: 6 },
      place: { timelineInSec: 10, durationSec: 5 },
      speed: 1,
    });

    const sequence = createSequence([
      createTrack({ id: 'video-track', kind: 'video', clips: [matchedVideoClip] }),
      createTrack({ id: 'audio-track', kind: 'audio', clips: [matchedAudioClip] }),
    ]);

    const result = collectPlaybackAudioClips(sequence, new Map([[videoAsset.id, videoAsset]]));

    expect(result.map((entry) => entry.clip.id)).toEqual(['audio-clip']);
  });

  it('keeps video-track audio when companion timing or range differs', () => {
    const videoAsset = createAsset({
      id: 'video-asset',
      kind: 'video',
      audio: { sampleRate: 48000, channels: 2, codec: 'aac' },
    });

    const sequence = createSequence([
      createTrack({
        id: 'video-track',
        kind: 'video',
        clips: [
          createClip({
            id: 'video-clip',
            assetId: 'video-asset',
            range: { sourceInSec: 0, sourceOutSec: 5 },
            place: { timelineInSec: 10, durationSec: 5 },
          }),
        ],
      }),
      createTrack({
        id: 'audio-track',
        kind: 'audio',
        clips: [
          createClip({
            id: 'audio-clip',
            assetId: 'video-asset',
            range: { sourceInSec: 5, sourceOutSec: 10 },
            place: { timelineInSec: 10, durationSec: 5 },
          }),
        ],
      }),
    ]);

    const result = collectPlaybackAudioClips(sequence, new Map([[videoAsset.id, videoAsset]]));

    expect(result.map((entry) => entry.clip.id)).toEqual(['video-clip', 'audio-clip']);
  });

  it('keeps companion suppression even when the audio track is muted', () => {
    const videoAsset = createAsset({
      id: 'video-asset',
      kind: 'video',
      audio: { sampleRate: 48000, channels: 2, codec: 'aac' },
    });

    const sequence = createSequence([
      createTrack({
        id: 'video-track',
        kind: 'video',
        clips: [createClip({ id: 'video-clip', assetId: 'video-asset' })],
      }),
      createTrack({
        id: 'audio-track',
        kind: 'audio',
        muted: true,
        clips: [createClip({ id: 'audio-clip', assetId: 'video-asset' })],
      }),
    ]);

    const result = collectPlaybackAudioClips(sequence, new Map([[videoAsset.id, videoAsset]]));

    expect(result).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { isCaptionLikeClip } from './captionClip';
import type { Clip, Track, Asset } from '@/types';

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
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
    ...overrides,
  };
}

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 'track-1',
    kind: 'video',
    name: 'Video 1',
    clips: [],
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1,
    ...overrides,
  };
}

function createAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    kind: 'video',
    name: 'video.mp4',
    uri: '/tmp/video.mp4',
    hash: 'hash',
    fileSize: 1,
    importedAt: '2024-01-01T00:00:00Z',
    license: {
      source: 'user',
      licenseType: 'unknown',
      allowedUse: [],
    },
    tags: [],
    proxyStatus: 'notNeeded',
    ...overrides,
  };
}

describe('isCaptionLikeClip', () => {
  it('returns true for clips on caption tracks', () => {
    const track = createTrack({ kind: 'caption' });
    const clip = createClip({ assetId: 'asset-video' });
    const asset = createAsset({ id: 'asset-video', kind: 'video' });

    expect(isCaptionLikeClip(track, clip, asset)).toBe(true);
  });

  it('returns true for subtitle assets on visual tracks', () => {
    const track = createTrack({ kind: 'video' });
    const clip = createClip({ assetId: 'asset-subtitle' });
    const asset = createAsset({ id: 'asset-subtitle', kind: 'subtitle' });

    expect(isCaptionLikeClip(track, clip, asset)).toBe(true);
  });

  it('returns false for normal video clips', () => {
    const track = createTrack({ kind: 'video' });
    const clip = createClip({ assetId: 'asset-video' });
    const asset = createAsset({ id: 'asset-video', kind: 'video' });

    expect(isCaptionLikeClip(track, clip, asset)).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProxyPreviewPlayer } from './ProxyPreviewPlayer';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import type { Asset, Clip, Sequence, Track } from '@/types';

function createClip(id: string, assetId: string): Clip {
  return {
    id,
    assetId,
    label: id,
    place: { timelineInSec: 0, durationSec: 10 },
    range: { sourceInSec: 0, sourceOutSec: 10 },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    speed: 1,
    opacity: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
  };
}

function createVideoTrack(id: string, clip: Clip): Track {
  return {
    id,
    name: id,
    kind: 'video',
    clips: [clip],
    blendMode: 'normal',
    muted: false,
    visible: true,
    locked: false,
    volume: 1,
  };
}

function createVideoAsset(id: string, uri: string): Asset {
  return {
    id,
    kind: 'video',
    name: `${id}.mp4`,
    uri,
    hash: id,
    fileSize: 100,
    importedAt: '2026-01-01T00:00:00.000Z',
    license: {
      source: 'user',
      licenseType: 'unknown',
      allowedUse: [],
    },
    tags: [],
    proxyStatus: 'notNeeded',
  };
}

function createSequence(): Sequence {
  const topClip = createClip('clip-top', 'asset-top');
  const bottomClip = createClip('clip-bottom', 'asset-bottom');

  return {
    id: 'sequence-1',
    name: 'Sequence 1',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [createVideoTrack('track-top', topClip), createVideoTrack('track-bottom', bottomClip)],
    markers: [],
  };
}

describe('ProxyPreviewPlayer', () => {
  beforeEach(() => {
    usePlaybackStore.getState().reset();
    usePlaybackStore.setState({
      currentTime: 2,
      duration: 20,
      isPlaying: false,
      syncWithTimeline: true,
      volume: 1,
      isMuted: false,
      playbackRate: 1,
    });
    useTimelineStore.setState({ selectedClipIds: [] });
  });

  it('keeps media layers non-interactive so controls are not blocked', () => {
    const sequence = createSequence();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(<ProxyPreviewPlayer sequence={sequence} assets={assets} showControls />);

    expect(screen.getByTestId('proxy-video-layer')).toHaveClass('pointer-events-none');
    expect(screen.getByTestId('proxy-video-clip-top')).toHaveClass('pointer-events-none');
    expect(screen.getByTestId('proxy-video-clip-bottom')).toHaveClass('pointer-events-none');
  });

  it('renders controls above the highest video track layer', () => {
    const sequence = createSequence();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(<ProxyPreviewPlayer sequence={sequence} assets={assets} showControls />);

    const controlsLayer = screen.getByTestId('proxy-controls-layer');
    const topVideo = screen.getByTestId('proxy-video-clip-top');

    const controlsZ = Number((controlsLayer as HTMLElement).style.zIndex);
    const videoZ = Number((topVideo as HTMLElement).style.zIndex);

    expect(Number.isFinite(controlsZ)).toBe(true);
    expect(Number.isFinite(videoZ)).toBe(true);
    expect(controlsZ).toBeGreaterThan(videoZ);
  });
});

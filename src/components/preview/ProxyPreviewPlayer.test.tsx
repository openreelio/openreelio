import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('does not render disabled clips in the preview stack', () => {
    const sequence = createSequence();
    sequence.tracks[0].clips[0].enabled = false;

    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(<ProxyPreviewPlayer sequence={sequence} assets={assets} showControls />);

    expect(screen.queryByTestId('proxy-video-clip-top')).not.toBeInTheDocument();
    expect(screen.getByTestId('proxy-video-clip-bottom')).toBeInTheDocument();
  });

  it('commits text placement from an inline preview input', async () => {
    const sequence = createSequence();
    const onTextPlacementCommit = vi.fn();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(
      <ProxyPreviewPlayer
        sequence={sequence}
        assets={assets}
        showControls
        textPlacementModeActive
        onTextPlacementCommit={onTextPlacementCommit}
      />,
    );

    const overlay = screen.getByTestId('text-placement-overlay');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(overlay, { clientX: 200, clientY: 150, button: 0 });
    const input = screen.getByTestId('text-placement-input');
    fireEvent.change(input, { target: { value: 'Placed title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(onTextPlacementCommit).toHaveBeenCalledWith({
        content: 'Placed title',
        position: { x: 0.5, y: 0.5 },
      });
    });
  });

  it('keeps the current text placement draft when the overlay is clicked again', () => {
    const sequence = createSequence();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(
      <ProxyPreviewPlayer
        sequence={sequence}
        assets={assets}
        showControls
        textPlacementModeActive
        onTextPlacementCommit={vi.fn()}
      />,
    );

    const overlay = screen.getByTestId('text-placement-overlay');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(overlay, { clientX: 200, clientY: 150, button: 0 });
    const input = screen.getByTestId('text-placement-input');
    fireEvent.change(input, { target: { value: 'Draft title' } });

    fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20, button: 0 });

    expect(screen.getByTestId('text-placement-input')).toHaveValue('Draft title');
  });

  it('does not commit text placement while IME composition is active', async () => {
    const sequence = createSequence();
    const onTextPlacementCommit = vi.fn();
    const assets = new Map<string, Asset>([
      ['asset-top', createVideoAsset('asset-top', 'https://example.com/top.mp4')],
      ['asset-bottom', createVideoAsset('asset-bottom', 'https://example.com/bottom.mp4')],
    ]);

    render(
      <ProxyPreviewPlayer
        sequence={sequence}
        assets={assets}
        showControls
        textPlacementModeActive
        onTextPlacementCommit={onTextPlacementCommit}
      />,
    );

    const overlay = screen.getByTestId('text-placement-overlay');
    Object.defineProperty(overlay, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(overlay, { clientX: 200, clientY: 150, button: 0 });
    const input = screen.getByTestId('text-placement-input');
    fireEvent.change(input, { target: { value: 'Composing title' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onTextPlacementCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId('text-placement-input')).toHaveValue('Composing title');

    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(onTextPlacementCommit).toHaveBeenCalledWith({
        content: 'Composing title',
        position: { x: 0.5, y: 0.5 },
      });
    });
  });
});

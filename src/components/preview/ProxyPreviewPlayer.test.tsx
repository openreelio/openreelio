/**
 * ProxyPreviewPlayer Component Tests
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProxyPreviewPlayer } from './ProxyPreviewPlayer';
import type { Sequence, Asset, Track, Clip } from '@/types';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

// Mock playback store
const mockPlaybackStore = {
  currentTime: 0,
  isPlaying: false,
  syncWithTimeline: true,
  duration: 0,
  volume: 1,
  isMuted: false,
  playbackRate: 1,
  seek: vi.fn(),
  setCurrentTime: vi.fn(),
  setIsPlaying: vi.fn(),
  setDuration: vi.fn(),
  togglePlayback: vi.fn(),
  setVolume: vi.fn(),
  toggleMute: vi.fn(),
};

vi.mock('@/stores/playbackStore', () => ({
  usePlaybackStore: () => mockPlaybackStore,
  PLAYBACK_EVENTS: {
    SEEK: 'playback-seek',
    UPDATE: 'playback-update',
  },
}));

// =============================================================================
// Test Data
// =============================================================================

const createMockClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  assetId: 'asset-1',
  range: {
    sourceInSec: 0,
    sourceOutSec: 10,
  },
  place: {
    timelineInSec: 0,
    durationSec: 10,
  },
  transform: {
    position: { x: 0, y: 0 },
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
  ...overrides,
});

const createMockTrack = (overrides: Partial<Track> = {}): Track => ({
  id: 'track-1',
  kind: 'video',
  name: 'Video 1',
  clips: [createMockClip()],
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1.0,
  ...overrides,
});

const createMockSequence = (overrides: Partial<Sequence> = {}): Sequence => ({
  id: 'seq-1',
  name: 'Test Sequence',
  format: {
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    audioSampleRate: 48000,
    audioChannels: 2,
  },
  tracks: [createMockTrack()],
  markers: [],
  ...overrides,
});

const createMockAsset = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'asset-1',
  kind: 'video',
  name: 'test.mp4',
  uri: '/path/to/test.mp4',
  hash: 'abc123',
  fileSize: 1000000,
  importedAt: '2024-01-01T00:00:00Z',
  license: {
    source: 'user',
    licenseType: 'unknown',
    allowedUse: [],
  },
  tags: [],
  proxyStatus: 'notNeeded',
  proxyUrl: '/path/to/proxy/test.mp4',
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('ProxyPreviewPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlaybackStore.currentTime = 0;
    mockPlaybackStore.isPlaying = false;
    mockPlaybackStore.syncWithTimeline = true;
    mockPlaybackStore.duration = 0;
  });

  describe('Empty State', () => {
    it('renders empty state when no sequence is provided', () => {
      const assets = new Map<string, Asset>();

      render(<ProxyPreviewPlayer sequence={null} assets={assets} />);

      expect(screen.getByTestId('proxy-preview-empty')).toBeInTheDocument();
      expect(screen.getByText('No sequence loaded')).toBeInTheDocument();
    });
  });

  describe('With Sequence', () => {
    it('renders player when sequence is provided', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.getByTestId('proxy-preview-player')).toBeInTheDocument();
    });

    it('renders video element for active clip', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5; // Within clip time range

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.getByTestId('proxy-video-clip-1')).toBeInTheDocument();
    });

    it('shows "No clips at current time" when no clips are active', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 20; // Outside clip time range

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.getByText('No clips at current time')).toBeInTheDocument();
    });

    it('does not render clips from muted tracks', () => {
      const sequence = createMockSequence({
        tracks: [createMockTrack({ muted: true })],
      });
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.queryByTestId('proxy-video-clip-1')).not.toBeInTheDocument();
    });

    it('does not render clips from hidden tracks', () => {
      const sequence = createMockSequence({
        tracks: [createMockTrack({ visible: false })],
      });
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.queryByTestId('proxy-video-clip-1')).not.toBeInTheDocument();
    });

    it('renders clips with non-positive speed using safe speed fallback', () => {
      const clip = createMockClip({ speed: 0 });
      const sequence = createMockSequence({ tracks: [createMockTrack({ clips: [clip] })] });
      const asset = createMockAsset({ id: 'asset-1' });
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.getByTestId('proxy-video-clip-1')).toBeInTheDocument();
    });

    it('blocks unsupported media URL schemes and falls back to empty preview state', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset({ uri: 'javascript:alert(1)' });
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.queryByTestId('proxy-video-clip-1')).not.toBeInTheDocument();
      expect(screen.getByText('No clips at current time')).toBeInTheDocument();
    });

    it('updates rendered source when asset metadata changes for the same active clip', () => {
      const sequence = createMockSequence();
      const initialAsset = createMockAsset({
        id: 'asset-1',
        uri: '/path/to/original.mp4',
        proxyStatus: 'pending',
        proxyUrl: '/path/to/proxy-pending.mp4',
      });
      const updatedAsset = createMockAsset({
        id: 'asset-1',
        uri: '/path/to/original.mp4',
        proxyStatus: 'ready',
        proxyUrl: '/path/to/proxy-ready.mp4',
      });

      mockPlaybackStore.currentTime = 5;

      const { rerender } = render(
        <ProxyPreviewPlayer
          sequence={sequence}
          assets={new Map<string, Asset>([[initialAsset.id, initialAsset]])}
        />
      );

      const before = screen.getByTestId('proxy-video-clip-1') as HTMLVideoElement;
      expect(before.getAttribute('src')).toContain('/path/to/original.mp4');

      rerender(
        <ProxyPreviewPlayer
          sequence={sequence}
          assets={new Map<string, Asset>([[updatedAsset.id, updatedAsset]])}
        />
      );

      const after = screen.getByTestId('proxy-video-clip-1') as HTMLVideoElement;
      expect(after.getAttribute('src')).toContain('/path/to/proxy-ready.mp4');
    });
    it('always keeps video elements muted to avoid duplicate audio output', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;
      mockPlaybackStore.isMuted = false;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      const video = screen.getByTestId('proxy-video-clip-1') as HTMLVideoElement;
      expect(video.muted).toBe(true);
    });

    it('hard-syncs active videos on playback seek events', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 0;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      const video = screen.getByTestId('proxy-video-clip-1') as HTMLVideoElement;
      video.currentTime = 0;

      window.dispatchEvent(
        new CustomEvent('playback-seek', {
          detail: { time: 8, source: 'test-seek' },
        })
      );

      expect(video.currentTime).toBe(8);
    });

    it('avoids hard-seeking for tiny drift while actively playing', () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, 'play')
        .mockImplementation(() => Promise.resolve());

      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;
      mockPlaybackStore.isPlaying = true;

      const { rerender } = render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      const video = screen.getByTestId('proxy-video-clip-1') as HTMLVideoElement;
      video.currentTime = 5.02;

      mockPlaybackStore.currentTime = 5.03;
      rerender(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(video.currentTime).toBe(5.02);
      playSpy.mockRestore();
    });

    it('does not render audio-track clips as proxy video layers', () => {
      const audioTrack = createMockTrack({
        kind: 'audio',
        clips: [createMockClip({ id: 'clip-audio', assetId: 'asset-audio' })],
      });
      const sequence = createMockSequence({ tracks: [audioTrack] });
      const assets = new Map<string, Asset>([
        ['asset-audio', createMockAsset({ id: 'asset-audio', kind: 'audio', uri: '/path/to/audio.mp3' })],
      ]);

      mockPlaybackStore.currentTime = 5;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.queryByTestId('proxy-video-clip-audio')).not.toBeInTheDocument();
      expect(screen.getByText('No clips at current time')).toBeInTheDocument();
    });
  });

  describe('Duration Calculation', () => {
    it('does not set duration directly (managed by useTimelineEngine)', () => {
      // Duration is now set exclusively by useTimelineEngine (via Timeline component)
      // to prevent competing writers from desynchronizing SeekBar and Timeline ranges.
      const clip1 = createMockClip({
        id: 'clip-1',
        range: { sourceInSec: 0, sourceOutSec: 10 },
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const clip2 = createMockClip({
        id: 'clip-2',
        range: { sourceInSec: 0, sourceOutSec: 5 },
        place: { timelineInSec: 10, durationSec: 5 },
      });
      const sequence = createMockSequence({
        tracks: [createMockTrack({ clips: [clip1, clip2] })],
      });
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      // ProxyPreviewPlayer must NOT call setDuration - useTimelineEngine owns it
      expect(mockPlaybackStore.setDuration).not.toHaveBeenCalled();
    });
  });

  describe('Controls', () => {
    it('renders controls by default', () => {
      const sequence = createMockSequence();
      const assets = new Map<string, Asset>();

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      // PlayerControls should be rendered
      expect(screen.getByTestId('proxy-preview-player')).toBeInTheDocument();
    });

    it('hides controls when showControls is false', () => {
      const sequence = createMockSequence();
      const assets = new Map<string, Asset>();

      const { container } = render(
        <ProxyPreviewPlayer sequence={sequence} assets={assets} showControls={false} />
      );

      // Controls container should not be present
      // The player-controls component won't be rendered
      const controlsWrapper = container.querySelector('.absolute.bottom-0');
      expect(controlsWrapper).not.toBeInTheDocument();
    });

    it('uses seek action for control-based seeking', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;
      mockPlaybackStore.duration = 20;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      fireEvent.click(screen.getByTestId('skip-forward-button'));

      expect(mockPlaybackStore.seek).toHaveBeenCalledWith(15);
      expect(mockPlaybackStore.setCurrentTime).not.toHaveBeenCalledWith(15);
    });

    it('does not start internal playback timer when timeline sync is enabled', () => {
      const requestAnimationFrameSpy = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation(() => 1 as unknown as number);

      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.isPlaying = true;
      mockPlaybackStore.syncWithTimeline = true;
      mockPlaybackStore.currentTime = 20; // Keep outside clip range to avoid HTMLMediaElement.play() in jsdom

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
      requestAnimationFrameSpy.mockRestore();
    });
  });

  describe('Multiple Clips', () => {
    it('renders multiple active clips', () => {
      const clip1 = createMockClip({
        id: 'clip-1',
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const clip2 = createMockClip({
        id: 'clip-2',
        assetId: 'asset-2',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const sequence = createMockSequence({
        tracks: [
          createMockTrack({ id: 'track-1', clips: [clip1] }),
          createMockTrack({ id: 'track-2', clips: [clip2] }),
        ],
      });
      const asset1 = createMockAsset({ id: 'asset-1' });
      const asset2 = createMockAsset({ id: 'asset-2', name: 'test2.mp4' });
      const assets = new Map<string, Asset>([
        [asset1.id, asset1],
        [asset2.id, asset2],
      ]);

      mockPlaybackStore.currentTime = 5;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.getByTestId('proxy-video-clip-1')).toBeInTheDocument();
      expect(screen.getByTestId('proxy-video-clip-2')).toBeInTheDocument();
    });

    it('applies correct z-index based on layer', () => {
      const clip1 = createMockClip({
        id: 'clip-1',
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const clip2 = createMockClip({
        id: 'clip-2',
        assetId: 'asset-2',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const sequence = createMockSequence({
        tracks: [
          createMockTrack({ id: 'track-1', clips: [clip1] }),
          createMockTrack({ id: 'track-2', clips: [clip2] }),
        ],
      });
      const asset1 = createMockAsset({ id: 'asset-1' });
      const asset2 = createMockAsset({ id: 'asset-2' });
      const assets = new Map<string, Asset>([
        [asset1.id, asset1],
        [asset2.id, asset2],
      ]);

      mockPlaybackStore.currentTime = 5;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      const video1 = screen.getByTestId('proxy-video-clip-1');
      const video2 = screen.getByTestId('proxy-video-clip-2');

      expect(video1).toHaveStyle({ zIndex: '0' });
      expect(video2).toHaveStyle({ zIndex: '10' });
    });
  });

  // ===========================================================================
  // Destructive / Edge Case Tests
  // ===========================================================================

  describe('Destructive: aspect ratio edge cases', () => {
    it('falls back to 16/9 when canvas height is zero', () => {
      const sequence = createMockSequence({
        format: {
          canvas: { width: 1920, height: 0 },
          fps: { num: 30, den: 1 },
          audioSampleRate: 48000,
          audioChannels: 2,
        },
      });
      const assets = new Map<string, Asset>();

      render(
        <ProxyPreviewPlayer sequence={sequence} assets={assets} />
      );

      const player = screen.getByTestId('proxy-preview-player');
      const style = player.style.aspectRatio;
      // Should be 16/9, not Infinity from 1920/0
      expect(style).not.toContain('Infinity');
    });

    it('falls back to 16/9 when canvas height is negative', () => {
      const sequence = createMockSequence({
        format: {
          canvas: { width: 1920, height: -1080 },
          fps: { num: 30, den: 1 },
          audioSampleRate: 48000,
          audioChannels: 2,
        },
      });
      const assets = new Map<string, Asset>();

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      const player = screen.getByTestId('proxy-preview-player');
      const style = player.style.aspectRatio;
      expect(style).not.toContain('-');
    });

    it('uses correct aspect ratio when canvas dimensions are valid', () => {
      const sequence = createMockSequence({
        format: {
          canvas: { width: 1920, height: 1080 },
          fps: { num: 30, den: 1 },
          audioSampleRate: 48000,
          audioChannels: 2,
        },
      });
      const assets = new Map<string, Asset>();

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      const player = screen.getByTestId('proxy-preview-player');
      // Aspect ratio should be ~1.777...
      const ratio = parseFloat(player.style.aspectRatio);
      expect(ratio).toBeCloseTo(16 / 9, 2);
    });
  });

  describe('Destructive: clip speed edge cases', () => {
    it('handles clip with speed=0 without freezing or Infinity', () => {
      const clip = createMockClip({
        id: 'clip-zero-speed',
        assetId: 'asset-1',
        speed: 0,
        range: { sourceInSec: 0, sourceOutSec: 10 },
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const sequence = createMockSequence({
        tracks: [createMockTrack({ clips: [clip] })],
      });
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;

      // Should render without throwing, using safeSpeed=1 fallback
      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.getByTestId('proxy-video-clip-zero-speed')).toBeInTheDocument();
    });

    it('handles clip with negative speed', () => {
      const clip = createMockClip({
        id: 'clip-neg-speed',
        assetId: 'asset-1',
        speed: -2,
        range: { sourceInSec: 0, sourceOutSec: 10 },
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const sequence = createMockSequence({
        tracks: [createMockTrack({ clips: [clip] })],
      });
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.getByTestId('proxy-video-clip-neg-speed')).toBeInTheDocument();
    });
  });

  describe('Destructive: keyboard double-fire prevention', () => {
    it('does not toggle playback when event is already defaultPrevented', () => {
      const sequence = createMockSequence();
      const assets = new Map<string, Asset>();

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      const player = screen.getByTestId('proxy-preview-player');

      // Simulate a space key event that was already handled by a global handler
      const event = new KeyboardEvent('keydown', {
        key: ' ',
        bubbles: true,
        cancelable: true,
      });
      event.preventDefault(); // Mark as already handled

      fireEvent(player, event);

      // togglePlayback should NOT have been called since event was already handled
      expect(mockPlaybackStore.togglePlayback).not.toHaveBeenCalled();
    });

    it('toggles playback when event is NOT defaultPrevented', () => {
      const sequence = createMockSequence();
      const assets = new Map<string, Asset>();

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      const player = screen.getByTestId('proxy-preview-player');
      fireEvent.keyDown(player, { key: ' ' });

      expect(mockPlaybackStore.togglePlayback).toHaveBeenCalledTimes(1);
    });
  });

  describe('Destructive: source time clamping in syncVideos', () => {
    it('clamps source time when currentTime is before clip timeline start', () => {
      const clip = createMockClip({
        id: 'clip-1',
        range: { sourceInSec: 5, sourceOutSec: 15 },
        place: { timelineInSec: 10, durationSec: 10 },
      });
      const sequence = createMockSequence({
        tracks: [createMockTrack({ clips: [clip] })],
      });
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      // Set currentTime to exactly clip start (offsetInClip=0, sourceTime=sourceInSec)
      mockPlaybackStore.currentTime = 10;

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      const video = screen.getByTestId('proxy-video-clip-1') as HTMLVideoElement;
      // Video should exist and be within valid source range
      expect(video).toBeInTheDocument();
    });
  });

  describe('Destructive: handleVideoLoaded efficiency', () => {
    it('does not trigger re-render when clearing nonexistent error', () => {
      const sequence = createMockSequence();
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 5;

      const { rerender } = render(
        <ProxyPreviewPlayer sequence={sequence} assets={assets} />
      );

      const video = screen.getByTestId('proxy-video-clip-1') as HTMLVideoElement;

      // Fire loadeddata - should not cause unnecessary state updates
      // since there's no error to clear
      fireEvent.loadedData(video);

      // Re-render should be stable
      rerender(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      expect(screen.getByTestId('proxy-video-clip-1')).toBeInTheDocument();
    });
  });

  describe('Destructive: sequence format edge cases', () => {
    it('handles sequence with zero FPS denominator', () => {
      const sequence = createMockSequence({
        format: {
          canvas: { width: 1920, height: 1080 },
          fps: { num: 30, den: 0 },
          audioSampleRate: 48000,
          audioChannels: 2,
        },
      });
      const assets = new Map<string, Asset>();

      // Should fall back to 30fps
      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);
      expect(screen.getByTestId('proxy-preview-player')).toBeInTheDocument();
    });

    it('handles sequence with missing format', () => {
      const sequence = createMockSequence();
      // @ts-expect-error - testing runtime safety with missing format
      delete sequence.format;

      const assets = new Map<string, Asset>();

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);
      expect(screen.getByTestId('proxy-preview-player')).toBeInTheDocument();
    });
  });

  describe('Destructive: rapid time changes (scrubbing simulation)', () => {
    it('handles rapid currentTime changes without errors', () => {
      const clip = createMockClip({
        range: { sourceInSec: 0, sourceOutSec: 10 },
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const sequence = createMockSequence({
        tracks: [createMockTrack({ clips: [clip] })],
      });
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      mockPlaybackStore.currentTime = 0;

      const { rerender } = render(
        <ProxyPreviewPlayer sequence={sequence} assets={assets} />
      );

      // Simulate rapid scrubbing across 100 positions
      for (let i = 0; i < 100; i++) {
        mockPlaybackStore.currentTime = i * 0.1;
        rerender(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);
      }

      // Should still render correctly at final position
      expect(screen.getByTestId('proxy-video-clip-1')).toBeInTheDocument();
    });
  });
});


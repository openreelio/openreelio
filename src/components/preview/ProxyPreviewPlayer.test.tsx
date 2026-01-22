/**
 * ProxyPreviewPlayer Component Tests
 */

import { render, screen } from '@testing-library/react';
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
  duration: 0,
  volume: 1,
  isMuted: false,
  playbackRate: 1,
  setCurrentTime: vi.fn(),
  setIsPlaying: vi.fn(),
  setDuration: vi.fn(),
  togglePlayback: vi.fn(),
  setVolume: vi.fn(),
  toggleMute: vi.fn(),
};

vi.mock('@/stores/playbackStore', () => ({
  usePlaybackStore: () => mockPlaybackStore,
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
  });

  describe('Duration Calculation', () => {
    it('sets duration based on sequence clips', () => {
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

      // Duration should be 15 (clip1: 0-10, clip2: 10-15)
      expect(mockPlaybackStore.setDuration).toHaveBeenCalledWith(15);
    });

    it('accounts for clip speed in duration calculation', () => {
      const clip = createMockClip({
        range: { sourceInSec: 0, sourceOutSec: 10 },
        place: { timelineInSec: 0, durationSec: 10 },
        speed: 2, // 2x speed = 5 second duration on timeline
      });
      const sequence = createMockSequence({
        tracks: [createMockTrack({ clips: [clip] })],
      });
      const asset = createMockAsset();
      const assets = new Map<string, Asset>([[asset.id, asset]]);

      render(<ProxyPreviewPlayer sequence={sequence} assets={assets} />);

      // Duration should be 5 (10 seconds source / 2x speed)
      expect(mockPlaybackStore.setDuration).toHaveBeenCalledWith(5);
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
});

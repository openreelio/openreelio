/**
 * usePreviewMode Hook Tests
 */

import { renderHook } from '@testing-library/react';
import { usePreviewMode, type UsePreviewModeOptions } from './usePreviewMode';
import type { Sequence, Asset, Track, Clip } from '@/types';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: `clip-${Math.random().toString(36).substr(2, 9)}`,
    assetId: 'asset-1',
    label: 'Test Clip',
    place: {
      timelineInSec: 0,
      durationSec: 10,
    },
    range: {
      sourceInSec: 0,
      sourceOutSec: 10,
    },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    speed: 1,
    opacity: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
    ...overrides,
  };
}

function createMockTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `track-${Math.random().toString(36).substr(2, 9)}`,
    name: 'Video 1',
    kind: 'video',
    clips: [],
    blendMode: 'normal',
    muted: false,
    visible: true,
    locked: false,
    volume: 1,
    ...overrides,
  };
}

function createMockSequence(tracks: Track[] = []): Sequence {
  return {
    id: 'sequence-1',
    name: 'Test Sequence',
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

function createMockAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset-1',
    kind: 'video',
    name: 'test-video.mp4',
    uri: '/path/to/video.mp4',
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
    ...overrides,
  };
}

function renderUsePreviewMode(options: UsePreviewModeOptions) {
  return renderHook(() => usePreviewMode(options));
}

// =============================================================================
// Tests
// =============================================================================

describe('usePreviewMode', () => {
  describe('no sequence loaded', () => {
    it('should return canvas mode when sequence is null', () => {
      const { result } = renderUsePreviewMode({
        sequence: null,
        assets: new Map(),
        currentTime: 0,
      });

      expect(result.current.mode).toBe('canvas');
      expect(result.current.reason).toBe('No sequence loaded');
    });
  });

  describe('no clips at playhead', () => {
    it('should return canvas mode when no clips at current time', () => {
      const track = createMockTrack({
        clips: [createMockClip({ place: { timelineInSec: 10, durationSec: 5 } })],
      });
      const sequence = createMockSequence([track]);
      const assets = new Map([['asset-1', createMockAsset()]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 0, // Before the clip
      });

      expect(result.current.mode).toBe('canvas');
      expect(result.current.reason).toBe('No clips at playhead');
    });

    it('should return canvas mode when playhead is past all clips', () => {
      const track = createMockTrack({
        clips: [createMockClip({ place: { timelineInSec: 0, durationSec: 5 } })],
      });
      const sequence = createMockSequence([track]);
      const assets = new Map([['asset-1', createMockAsset()]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 10, // After the clip
      });

      expect(result.current.mode).toBe('canvas');
      expect(result.current.reason).toBe('No clips at playhead');
    });
  });

  describe('video mode selection', () => {
    it('should return video mode when all video clips have ready proxies', () => {
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip] });
      const sequence = createMockSequence([track]);
      const asset = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'ready',
        proxyUrl: 'asset://localhost/proxy.mp4',
      });
      const assets = new Map([['asset-1', asset]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 5,
      });

      expect(result.current.mode).toBe('video');
      expect(result.current.reason).toBe('All video clips have ready proxies');
      expect(result.current.hasGeneratingProxy).toBe(false);
    });

    it('should return video mode with multiple clips all having ready proxies', () => {
      const clip1 = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const clip2 = createMockClip({
        id: 'clip-2',
        assetId: 'asset-2',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip1, clip2] });
      const sequence = createMockSequence([track]);

      const asset1 = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'ready',
        proxyUrl: 'asset://localhost/proxy1.mp4',
      });
      const asset2 = createMockAsset({
        id: 'asset-2',
        name: 'video2.mp4',
        proxyStatus: 'ready',
        proxyUrl: 'asset://localhost/proxy2.mp4',
      });
      const assets = new Map([
        ['asset-1', asset1],
        ['asset-2', asset2],
      ]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 7, // Both clips active
      });

      expect(result.current.mode).toBe('video');
    });
  });

  describe('canvas mode fallback', () => {
    it('should return canvas mode when any clip has pending proxy', () => {
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip] });
      const sequence = createMockSequence([track]);
      const asset = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'pending',
      });
      const assets = new Map([['asset-1', asset]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 5,
      });

      expect(result.current.mode).toBe('canvas');
      expect(result.current.clipsNeedingProxy).toBe(1);
    });

    it('should return canvas mode when any clip has generating proxy', () => {
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip] });
      const sequence = createMockSequence([track]);
      const asset = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'generating',
      });
      const assets = new Map([['asset-1', asset]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 5,
      });

      expect(result.current.mode).toBe('canvas');
      expect(result.current.hasGeneratingProxy).toBe(true);
      expect(result.current.reason).toContain('Proxies generating');
    });

    it('should return canvas mode when any clip has failed proxy', () => {
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip] });
      const sequence = createMockSequence([track]);
      const asset = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'failed',
      });
      const assets = new Map([['asset-1', asset]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 5,
      });

      expect(result.current.mode).toBe('canvas');
    });

    it('should return canvas mode when clip has notNeeded proxy status', () => {
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip] });
      const sequence = createMockSequence([track]);
      const asset = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'notNeeded',
      });
      const assets = new Map([['asset-1', asset]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 5,
      });

      // notNeeded means no proxy available, so canvas mode
      expect(result.current.mode).toBe('canvas');
    });

    it('should fall back to canvas if one of multiple clips lacks proxy', () => {
      const clip1 = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const clip2 = createMockClip({
        id: 'clip-2',
        assetId: 'asset-2',
        place: { timelineInSec: 5, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip1, clip2] });
      const sequence = createMockSequence([track]);

      const asset1 = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'ready',
        proxyUrl: 'asset://localhost/proxy1.mp4',
      });
      const asset2 = createMockAsset({
        id: 'asset-2',
        proxyStatus: 'pending',
      });
      const assets = new Map([
        ['asset-1', asset1],
        ['asset-2', asset2],
      ]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 7, // Both clips active
      });

      expect(result.current.mode).toBe('canvas');
      expect(result.current.clipsNeedingProxy).toBe(1);
    });
  });

  describe('image assets', () => {
    it('should return canvas mode for image assets', () => {
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip] });
      const sequence = createMockSequence([track]);
      const asset = createMockAsset({
        id: 'asset-1',
        kind: 'image',
        name: 'image.png',
        proxyStatus: 'notNeeded',
      });
      const assets = new Map([['asset-1', asset]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 5,
      });

      expect(result.current.mode).toBe('canvas');
      expect(result.current.reason).toBe('No video clips (images use canvas)');
    });
  });

  describe('muted/hidden tracks', () => {
    it('should ignore muted tracks', () => {
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip], muted: true });
      const sequence = createMockSequence([track]);
      const asset = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'ready',
        proxyUrl: 'asset://localhost/proxy.mp4',
      });
      const assets = new Map([['asset-1', asset]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 5,
      });

      expect(result.current.mode).toBe('canvas');
      expect(result.current.reason).toBe('No clips at playhead');
    });

    it('should ignore hidden tracks', () => {
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip], visible: false });
      const sequence = createMockSequence([track]);
      const asset = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'ready',
        proxyUrl: 'asset://localhost/proxy.mp4',
      });
      const assets = new Map([['asset-1', asset]]);

      const { result } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 5,
      });

      expect(result.current.mode).toBe('canvas');
    });
  });

  describe('clip timing calculations', () => {
    it('should correctly identify clips spanning playhead with speed adjustment', () => {
      // Clip with 2x speed: 10s source = 5s on timeline
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 5 }, // Will be ignored, calculated from source/speed
        range: { sourceInSec: 0, sourceOutSec: 10 },
        speed: 2,
      });
      const track = createMockTrack({ clips: [clip] });
      const sequence = createMockSequence([track]);
      const asset = createMockAsset({
        id: 'asset-1',
        proxyStatus: 'ready',
        proxyUrl: 'asset://localhost/proxy.mp4',
      });
      const assets = new Map([['asset-1', asset]]);

      // At time 3, clip should be active (0 to 5 seconds on timeline)
      const { result: result1 } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 3,
      });
      expect(result1.current.mode).toBe('video');

      // At time 6, clip should not be active
      const { result: result2 } = renderUsePreviewMode({
        sequence,
        assets,
        currentTime: 6,
      });
      expect(result2.current.mode).toBe('canvas');
    });
  });
});

/**
 * usePreviewSource Hook Tests
 *
 * Tests for determining the video source to display in the preview player:
 * - Priority 1: Selected asset from project explorer
 * - Priority 2: Clip at current timeline playhead position
 * - Null when no source available
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePreviewSource } from './usePreviewSource';
import { useProjectStore } from '@/stores';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Asset, Sequence, Track, Clip } from '@/types';

type ProjectStoreSelector = NonNullable<Parameters<typeof useProjectStore>[0]>;
type ProjectStoreState = Parameters<ProjectStoreSelector>[0];

// =============================================================================
// Mocks
// =============================================================================

vi.mock('@/stores', () => ({
  useProjectStore: vi.fn(),
}));

vi.mock('@/stores/playbackStore', () => ({
  usePlaybackStore: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

// =============================================================================
// Test Fixtures
// =============================================================================

const createMockAsset = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'asset-1',
  name: 'test-video.mp4',
  kind: 'video',
  uri: '/path/to/video.mp4',
  hash: 'abc123',
  fileSize: 1024000,
  durationSec: 60,
  video: {
    codec: 'h264',
    width: 1920,
    height: 1080,
    fps: { num: 30, den: 1 },
    hasAlpha: false,
  },
  thumbnailUrl: '/path/to/thumb.jpg',
  importedAt: new Date().toISOString(),
  license: {
    source: 'user',
    licenseType: 'royalty_free',
    allowedUse: ['commercial'],
  },
  tags: [],
  ...overrides,
});

const createMockClip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  assetId: 'asset-1',
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
    anchor: { x: 0, y: 0 },
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
  name: 'Video Track 1',
  clips: [],
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1,
  ...overrides,
});

const createMockSequence = (tracks: Track[] = []): Sequence => ({
  id: 'seq-1',
  name: 'Test Sequence',
  format: {
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    audioSampleRate: 48000,
    audioChannels: 2,
  },
  tracks,
  markers: [],
});

// =============================================================================
// Test Setup
// =============================================================================

describe('usePreviewSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // No Source Available
  // ===========================================================================

  describe('no source available', () => {
    it('should return null when no asset is selected and no sequence exists', () => {
      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map<string, Asset>(),
          activeSequenceId: null,
          sequences: new Map<string, Sequence>(),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 0 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current).toBeNull();
    });

    it('should return null when sequence has no clips', () => {
      const sequence = createMockSequence([createMockTrack({ clips: [] })]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map<string, Asset>(),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 0 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current).toBeNull();
    });
  });

  // ===========================================================================
  // Priority 1: Selected Asset
  // ===========================================================================

  describe('selected asset (priority 1)', () => {
    it('should return selected video asset source', () => {
      const asset = createMockAsset({ id: 'asset-1', kind: 'video' });

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: 'asset-1',
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: null,
          sequences: new Map<string, Sequence>(),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 0 });

      const { result } = renderHook(() => usePreviewSource());

      expect(result.current).not.toBeNull();
      expect(result.current?.assetId).toBe('asset-1');
      expect(result.current?.sourceType).toBe('asset');
      expect(result.current?.src).toContain(asset.uri);
    });

    it('should return selected image asset source', () => {
      const asset = createMockAsset({
        id: 'asset-2',
        kind: 'image',
        uri: '/path/to/image.png',
      });

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: 'asset-2',
          assets: new Map([['asset-2', asset]]),
          activeSequenceId: null,
          sequences: new Map<string, Sequence>(),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 0 });

      const { result } = renderHook(() => usePreviewSource());

      expect(result.current).not.toBeNull();
      expect(result.current?.assetId).toBe('asset-2');
      expect(result.current?.sourceType).toBe('asset');
    });

    it('should return null when selected asset is audio only', () => {
      const asset = createMockAsset({
        id: 'asset-3',
        kind: 'audio',
        uri: '/path/to/audio.mp3',
      });

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: 'asset-3',
          assets: new Map([['asset-3', asset]]),
          activeSequenceId: null,
          sequences: new Map<string, Sequence>(),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 0 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current).toBeNull();
    });

    it('should return null when selected asset id is not found', () => {
      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: 'non-existent',
          assets: new Map<string, Asset>(),
          activeSequenceId: null,
          sequences: new Map<string, Sequence>(),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 0 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current).toBeNull();
    });

    it('should include thumbnail in preview source', () => {
      const asset = createMockAsset({
        thumbnailUrl: '/path/to/thumbnail.jpg',
      });

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: 'asset-1',
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: null,
          sequences: new Map<string, Sequence>(),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 0 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current?.thumbnail).toBe('/path/to/thumbnail.jpg');
    });
  });

  // ===========================================================================
  // Priority 2: Timeline Clip
  // ===========================================================================

  describe('timeline clip (priority 2)', () => {
    it('should return clip at current playhead position', () => {
      const asset = createMockAsset({ id: 'asset-1' });
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
        range: { sourceInSec: 0, sourceOutSec: 10 },
      });
      const track = createMockTrack({ clips: [clip], kind: 'video' });
      const sequence = createMockSequence([track]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 5 });

      const { result } = renderHook(() => usePreviewSource());

      expect(result.current).not.toBeNull();
      expect(result.current?.assetId).toBe('asset-1');
      expect(result.current?.sourceType).toBe('timeline');
    });

    it('should calculate correct source offset for timeline clip', () => {
      const asset = createMockAsset({ id: 'asset-1' });
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 10, durationSec: 15 },
        range: { sourceInSec: 5, sourceOutSec: 20 },
        speed: 1,
      });
      const track = createMockTrack({ clips: [clip], kind: 'video' });
      const sequence = createMockSequence([track]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      // Playhead at timeline position 15 (5 seconds into clip)
      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 15 });

      const { result } = renderHook(() => usePreviewSource());

      // Source offset should be: sourceInSec + (timelineTime - clipStart) * speed
      // = 5 + (15 - 10) * 1 = 10
      expect(result.current?.sourceOffset).toBe(10);
    });

    it('should calculate source offset with speed modifier', () => {
      const asset = createMockAsset({ id: 'asset-1' });
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
        range: { sourceInSec: 0, sourceOutSec: 20 },
        speed: 2, // 2x speed
      });
      const track = createMockTrack({ clips: [clip], kind: 'video' });
      const sequence = createMockSequence([track]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      // Playhead at timeline position 5 (5 seconds at 2x speed = 10 seconds in source)
      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 5 });

      const { result } = renderHook(() => usePreviewSource());

      // Source offset should be: 0 + (5 - 0) * 2 = 10
      expect(result.current?.sourceOffset).toBe(10);
    });

    it('should return null when playhead is before first clip', () => {
      const asset = createMockAsset({ id: 'asset-1' });
      const clip = createMockClip({
        place: { timelineInSec: 10, durationSec: 15 },
      });
      const track = createMockTrack({ clips: [clip], kind: 'video' });
      const sequence = createMockSequence([track]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 5 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current).toBeNull();
    });

    it('should return null when playhead is after last clip', () => {
      const asset = createMockAsset({ id: 'asset-1' });
      const clip = createMockClip({
        place: { timelineInSec: 0, durationSec: 10 },
        range: { sourceInSec: 0, sourceOutSec: 10 },
      });
      const track = createMockTrack({ clips: [clip], kind: 'video' });
      const sequence = createMockSequence([track]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 15 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current).toBeNull();
    });

    it('should ignore audio tracks when finding clip', () => {
      const videoAsset = createMockAsset({ id: 'video-asset', kind: 'video' });
      const audioAsset = createMockAsset({ id: 'audio-asset', kind: 'audio' });

      const audioClip = createMockClip({
        id: 'audio-clip',
        assetId: 'audio-asset',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const audioTrack = createMockTrack({
        id: 'audio-track',
        kind: 'audio',
        clips: [audioClip],
      });

      const sequence = createMockSequence([audioTrack]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map([
            ['video-asset', videoAsset],
            ['audio-asset', audioAsset],
          ]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 5 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current).toBeNull();
    });

    it('should ignore muted tracks', () => {
      const asset = createMockAsset({ id: 'asset-1' });
      const clip = createMockClip({ assetId: 'asset-1' });
      const track = createMockTrack({
        clips: [clip],
        kind: 'video',
        muted: true,
      });
      const sequence = createMockSequence([track]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 5 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current).toBeNull();
    });

    it('should ignore hidden tracks', () => {
      const asset = createMockAsset({ id: 'asset-1' });
      const clip = createMockClip({ assetId: 'asset-1' });
      const track = createMockTrack({
        clips: [clip],
        kind: 'video',
        visible: false,
      });
      const sequence = createMockSequence([track]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 5 });

      const { result } = renderHook(() => usePreviewSource());
      expect(result.current).toBeNull();
    });
  });

  // ===========================================================================
  // Priority Order
  // ===========================================================================

  describe('priority order', () => {
    it('should prioritize selected asset over timeline clip', () => {
      const selectedAsset = createMockAsset({ id: 'selected-asset', name: 'selected.mp4' });
      const timelineAsset = createMockAsset({ id: 'timeline-asset', name: 'timeline.mp4' });

      const clip = createMockClip({
        assetId: 'timeline-asset',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip], kind: 'video' });
      const sequence = createMockSequence([track]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: 'selected-asset',
          assets: new Map([
            ['selected-asset', selectedAsset],
            ['timeline-asset', timelineAsset],
          ]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as unknown as ProjectStoreState);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 5 });

      const { result } = renderHook(() => usePreviewSource());

      expect(result.current?.assetId).toBe('selected-asset');
      expect(result.current?.sourceType).toBe('asset');
    });
  });

  // ===========================================================================
  // Return Value Structure
  // ===========================================================================

  describe('return value structure', () => {
    it('should return correct structure for asset source', () => {
      const asset = createMockAsset({
        id: 'asset-1',
        name: 'test-video.mp4',
        uri: '/path/to/video.mp4',
        thumbnailUrl: '/path/to/thumb.jpg',
      });

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: 'asset-1',
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: null,
          sequences: new Map<string, Sequence>(),
        };
        return selector(state as any);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 0 });

      const { result } = renderHook(() => usePreviewSource());

      expect(result.current).toMatchObject({
        src: expect.any(String),
        assetUri: '/path/to/video.mp4',
        assetId: 'asset-1',
        name: 'test-video.mp4',
        sourceType: 'asset',
        thumbnail: '/path/to/thumb.jpg',
      });
      expect(result.current?.sourceOffset).toBeUndefined();
    });

    it('should return correct structure for timeline source', () => {
      const asset = createMockAsset({ id: 'asset-1' });
      const clip = createMockClip({
        assetId: 'asset-1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const track = createMockTrack({ clips: [clip], kind: 'video' });
      const sequence = createMockSequence([track]);

      vi.mocked(useProjectStore).mockImplementation((selector) => {
        const state = {
          selectedAssetId: null,
          assets: new Map([['asset-1', asset]]),
          activeSequenceId: 'seq-1',
          sequences: new Map([['seq-1', sequence]]),
        };
        return selector(state as any);
      });

      vi.mocked(usePlaybackStore).mockReturnValue({ currentTime: 5 });

      const { result } = renderHook(() => usePreviewSource());

      expect(result.current).toMatchObject({
        src: expect.any(String),
        assetUri: expect.any(String),
        assetId: 'asset-1',
        name: expect.any(String),
        sourceType: 'timeline',
        sourceOffset: expect.any(Number),
      });
    });
  });
});

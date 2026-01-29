/**
 * useVideoSync Hook Tests
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  useVideoSync,
  calculateTimelineTime,
  isTimeInClip,
  getClipTimelineDuration,
} from './useVideoSync';
import type { Clip, Asset } from '@/types';

// Mock playback store
const mockPlaybackStore = {
  currentTime: 0,
  isPlaying: false,
  playbackRate: 1,
  syncWithTimeline: true,
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
  ...overrides,
});

const createMockVideoElement = (): HTMLVideoElement => {
  const video = {
    currentTime: 0,
    playbackRate: 1,
    paused: true,
    readyState: HTMLMediaElement.HAVE_ENOUGH_DATA,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HTMLVideoElement;
  return video;
};

// =============================================================================
// Hook Tests
// =============================================================================

describe('useVideoSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlaybackStore.currentTime = 0;
    mockPlaybackStore.isPlaying = false;
    mockPlaybackStore.playbackRate = 1;
    mockPlaybackStore.syncWithTimeline = true;
  });

  describe('syncVideo', () => {
    it('syncs video currentTime to timeline position', () => {
      const clip = createMockClip();
      const video = createMockVideoElement();
      const videoRefs = new Map<string, HTMLVideoElement>([[clip.id, video]]);
      const assets = new Map<string, Asset>([[createMockAsset().id, createMockAsset()]]);

      mockPlaybackStore.currentTime = 5;

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip], assets })
      );

      act(() => {
        result.current.syncVideo(clip.id);
      });

      expect(video.currentTime).toBe(5);
    });

    it('accounts for clip speed', () => {
      const clip = createMockClip({ speed: 2 });
      const video = createMockVideoElement();
      const videoRefs = new Map<string, HTMLVideoElement>([[clip.id, video]]);
      const assets = new Map<string, Asset>([[createMockAsset().id, createMockAsset()]]);

      mockPlaybackStore.currentTime = 2.5; // 2.5 sec on timeline
      // With 2x speed, source time should be 5 (2.5 * 2)

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip], assets })
      );

      act(() => {
        result.current.syncVideo(clip.id);
      });

      expect(video.currentTime).toBe(5);
    });

    it('accounts for clip offset', () => {
      const clip = createMockClip({
        place: { timelineInSec: 10, durationSec: 10 },
      });
      const video = createMockVideoElement();
      const videoRefs = new Map<string, HTMLVideoElement>([[clip.id, video]]);
      const assets = new Map<string, Asset>([[createMockAsset().id, createMockAsset()]]);

      mockPlaybackStore.currentTime = 13; // 13 sec on timeline, clip starts at 10

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip], assets })
      );

      act(() => {
        result.current.syncVideo(clip.id);
      });

      expect(video.currentTime).toBe(3); // 13 - 10 = 3 seconds into clip
    });

    it('sets playback rate with clip speed', () => {
      const clip = createMockClip({ speed: 1.5 });
      const video = createMockVideoElement();
      const videoRefs = new Map<string, HTMLVideoElement>([[clip.id, video]]);
      const assets = new Map<string, Asset>([[createMockAsset().id, createMockAsset()]]);

      mockPlaybackStore.playbackRate = 2;

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip], assets })
      );

      act(() => {
        result.current.syncVideo(clip.id);
      });

      expect(video.playbackRate).toBe(3); // 2 * 1.5
    });

    it('plays video when isPlaying is true', () => {
      const clip = createMockClip();
      const video = createMockVideoElement();
      const videoRefs = new Map<string, HTMLVideoElement>([[clip.id, video]]);
      const assets = new Map<string, Asset>([[createMockAsset().id, createMockAsset()]]);

      mockPlaybackStore.isPlaying = true;

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip], assets })
      );

      act(() => {
        result.current.syncVideo(clip.id);
      });

      expect(video.play).toHaveBeenCalled();
    });

    it('pauses video when isPlaying is false', () => {
      const clip = createMockClip();
      const video = createMockVideoElement();
      (video as { paused: boolean }).paused = false; // Video is currently playing
      const videoRefs = new Map<string, HTMLVideoElement>([[clip.id, video]]);
      const assets = new Map<string, Asset>([[createMockAsset().id, createMockAsset()]]);

      mockPlaybackStore.isPlaying = false;

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip], assets })
      );

      act(() => {
        result.current.syncVideo(clip.id);
      });

      expect(video.pause).toHaveBeenCalled();
    });
  });

  describe('syncAll', () => {
    it('syncs all video elements', () => {
      const clip1 = createMockClip({ id: 'clip-1' });
      const clip2 = createMockClip({ id: 'clip-2' });
      const video1 = createMockVideoElement();
      const video2 = createMockVideoElement();
      const videoRefs = new Map<string, HTMLVideoElement>([
        [clip1.id, video1],
        [clip2.id, video2],
      ]);
      const assets = new Map<string, Asset>([[createMockAsset().id, createMockAsset()]]);

      mockPlaybackStore.currentTime = 5;

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip1, clip2], assets })
      );

      act(() => {
        result.current.syncAll();
      });

      expect(video1.currentTime).toBe(5);
      expect(video2.currentTime).toBe(5);
    });
  });

  describe('disabled state', () => {
    it('does not sync when disabled', () => {
      const clip = createMockClip();
      const video = createMockVideoElement();
      const videoRefs = new Map<string, HTMLVideoElement>([[clip.id, video]]);
      const assets = new Map<string, Asset>([[createMockAsset().id, createMockAsset()]]);

      mockPlaybackStore.currentTime = 5;

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip], assets, enabled: false })
      );

      act(() => {
        result.current.syncVideo(clip.id);
      });

      expect(video.currentTime).toBe(0); // Should not change
    });
  });

  describe('asset verification', () => {
    it('does not sync when asset is not found', () => {
      const clip = createMockClip({ assetId: 'non-existent-asset' });
      const video = createMockVideoElement();
      const videoRefs = new Map<string, HTMLVideoElement>([[clip.id, video]]);
      const assets = new Map<string, Asset>(); // Empty assets map

      mockPlaybackStore.currentTime = 5;

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip], assets })
      );

      act(() => {
        result.current.syncVideo(clip.id);
      });

      expect(video.currentTime).toBe(0); // Should not change
    });

    it('syncs only clips with valid assets', () => {
      const clip1 = createMockClip({ id: 'clip-1', assetId: 'asset-1' });
      const clip2 = createMockClip({ id: 'clip-2', assetId: 'non-existent' });
      const video1 = createMockVideoElement();
      const video2 = createMockVideoElement();
      const videoRefs = new Map<string, HTMLVideoElement>([
        [clip1.id, video1],
        [clip2.id, video2],
      ]);
      const assets = new Map<string, Asset>([[createMockAsset().id, createMockAsset()]]);

      mockPlaybackStore.currentTime = 5;

      const { result } = renderHook(() =>
        useVideoSync({ videoRefs, clips: [clip1, clip2], assets })
      );

      act(() => {
        result.current.syncAll();
      });

      expect(video1.currentTime).toBe(5); // Asset exists, should sync
      expect(video2.currentTime).toBe(0); // Asset missing, should not sync
    });
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================

describe('calculateTimelineTime', () => {
  it('calculates timeline time from source time', () => {
    const clip = createMockClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 5, durationSec: 10 },
      speed: 1,
    });

    expect(calculateTimelineTime(clip, 3)).toBe(8); // 5 + 3
  });

  it('accounts for speed', () => {
    const clip = createMockClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 0, durationSec: 10 },
      speed: 2,
    });

    // At 2x speed, 4 seconds of source = 2 seconds on timeline
    expect(calculateTimelineTime(clip, 4)).toBe(2);
  });

  it('handles source offset', () => {
    const clip = createMockClip({
      range: { sourceInSec: 5, sourceOutSec: 15 },
      place: { timelineInSec: 0, durationSec: 10 },
      speed: 1,
    });

    // Source at 8 = 3 seconds into clip = timeline 3
    expect(calculateTimelineTime(clip, 8)).toBe(3);
  });
});

describe('isTimeInClip', () => {
  it('returns true when time is within clip', () => {
    const clip = createMockClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 5, durationSec: 10 },
      speed: 1,
    });

    expect(isTimeInClip(clip, 5)).toBe(true);  // Start
    expect(isTimeInClip(clip, 10)).toBe(true); // Middle
  });

  it('returns false when time is before clip', () => {
    const clip = createMockClip({
      place: { timelineInSec: 5, durationSec: 10 },
    });

    expect(isTimeInClip(clip, 4)).toBe(false);
  });

  it('returns false when time is at or after clip end', () => {
    const clip = createMockClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 0, durationSec: 10 },
      speed: 1,
    });

    expect(isTimeInClip(clip, 10)).toBe(false); // Exactly at end
    expect(isTimeInClip(clip, 15)).toBe(false); // After end
  });

  it('accounts for speed in clip duration', () => {
    const clip = createMockClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      place: { timelineInSec: 0, durationSec: 10 },
      speed: 2, // 10 source sec / 2 = 5 timeline sec
    });

    expect(isTimeInClip(clip, 4)).toBe(true);
    expect(isTimeInClip(clip, 5)).toBe(false); // At end
    expect(isTimeInClip(clip, 6)).toBe(false);
  });
});

describe('getClipTimelineDuration', () => {
  it('calculates duration at normal speed', () => {
    const clip = createMockClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      speed: 1,
    });

    expect(getClipTimelineDuration(clip)).toBe(10);
  });

  it('calculates duration with speed multiplier', () => {
    const clip = createMockClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      speed: 2,
    });

    expect(getClipTimelineDuration(clip)).toBe(5); // 10 / 2
  });

  it('calculates duration with slow speed', () => {
    const clip = createMockClip({
      range: { sourceInSec: 0, sourceOutSec: 10 },
      speed: 0.5,
    });

    expect(getClipTimelineDuration(clip)).toBe(20); // 10 / 0.5
  });

  it('calculates duration with source offset', () => {
    const clip = createMockClip({
      range: { sourceInSec: 5, sourceOutSec: 15 },
      speed: 1,
    });

    expect(getClipTimelineDuration(clip)).toBe(10); // 15 - 5
  });
});

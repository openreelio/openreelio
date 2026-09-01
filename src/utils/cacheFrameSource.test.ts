import { describe, expect, it } from 'vitest';
import type { CacheSegmentStatusDto, RenderCacheStatus } from '@/bindings';
import {
  cacheFrameAssetId,
  cacheFrameOffsetSec,
  cacheSegmentsForSequence,
  findSegmentForTime,
  resolveCachedSegmentForTime,
} from './cacheFrameSource';

function createSegment(overrides: Partial<CacheSegmentStatusDto> = {}): CacheSegmentStatusDto {
  return {
    index: 0,
    startSec: 0,
    endSec: 5,
    state: 'cached',
    fingerprint: '42',
    cachedPath: '/cache/seq/seg-0.mov',
    flagged: false,
    flagReasons: [],
    ...overrides,
  };
}

const NO_DEAD_PATHS: ReadonlySet<string> = new Set<string>();

describe('findSegmentForTime', () => {
  const segments = [
    createSegment({ index: 0, startSec: 0, endSec: 5 }),
    createSegment({ index: 1, startSec: 5, endSec: 10, cachedPath: '/cache/seq/seg-1.mov' }),
  ];

  it('should return the segment owning the time when the time is inside it', () => {
    expect(findSegmentForTime(segments, 2.5)?.index).toBe(0);
    expect(findSegmentForTime(segments, 7)?.index).toBe(1);
  });

  it('should treat a segment boundary as belonging to the later segment', () => {
    expect(findSegmentForTime(segments, 5)?.index).toBe(1);
  });

  it('should clamp the very end of the timeline into the last segment', () => {
    // The playhead can park exactly on the final end time and no later segment
    // owns that instant.
    expect(findSegmentForTime(segments, 10)?.index).toBe(1);
  });

  it('should return null when the time falls outside every segment', () => {
    expect(findSegmentForTime(segments, -1)).toBeNull();
    expect(findSegmentForTime(segments, 10.5)).toBeNull();
  });

  it('should return null when there are no segments or the time is not finite', () => {
    expect(findSegmentForTime([], 1)).toBeNull();
    expect(findSegmentForTime(segments, Number.NaN)).toBeNull();
  });
});

describe('resolveCachedSegmentForTime', () => {
  it('should return the segment when it is cached with a usable path', () => {
    const segments = [createSegment()];

    expect(resolveCachedSegmentForTime(segments, 1, NO_DEAD_PATHS)?.index).toBe(0);
  });

  it('should serve a flagged segment, because a cached frame is the export composite', () => {
    const segments = [createSegment({ flagged: true, flagReasons: ['blend_mode'] })];

    expect(resolveCachedSegmentForTime(segments, 1, NO_DEAD_PATHS)).not.toBeNull();
  });

  it('should exclude a segment whose file another consumer found unplayable', () => {
    const segments = [createSegment()];
    const dead = new Set(['/cache/seq/seg-0.mov']);

    expect(resolveCachedSegmentForTime(segments, 1, dead)).toBeNull();
  });

  it('should exclude segments that are not cached', () => {
    for (const state of ['empty', 'rendering', 'stale', 'error'] as const) {
      const segments = [createSegment({ state })];

      expect(resolveCachedSegmentForTime(segments, 1, NO_DEAD_PATHS)).toBeNull();
    }
  });

  it('should exclude a cached segment the backend refused to hand a path for', () => {
    const segments = [createSegment({ cachedPath: null })];

    expect(resolveCachedSegmentForTime(segments, 1, NO_DEAD_PATHS)).toBeNull();
  });
});

describe('cacheSegmentsForSequence', () => {
  const status: RenderCacheStatus = {
    enabled: true,
    sequenceId: 'sequence-1',
    totalSegments: 1,
    cachedSegments: 1,
    staleSegments: 0,
    renderingSegments: 0,
    completionPercent: 100,
    totalCachedBytes: 1024,
    maxCacheBytes: 1073741824,
    segmentStates: [createSegment()],
  };

  it('should hand back the segments when the snapshot describes the sequence', () => {
    expect(cacheSegmentsForSequence(status, 'sequence-1')).toHaveLength(1);
  });

  it('should hand back nothing when the snapshot describes another sequence', () => {
    // A snapshot taken before a sequence switch names files under the previous
    // sequence's cache directory; drawing one would show a different edit.
    expect(cacheSegmentsForSequence(status, 'sequence-2')).toHaveLength(0);
    expect(
      resolveCachedSegmentForTime(cacheSegmentsForSequence(status, 'sequence-2'), 1, NO_DEAD_PATHS),
    ).toBeNull();
  });

  it('should hand back nothing without a snapshot or without a sequence', () => {
    expect(cacheSegmentsForSequence(null, 'sequence-1')).toHaveLength(0);
    expect(cacheSegmentsForSequence(status, null)).toHaveLength(0);
  });
});

describe('cacheFrameAssetId', () => {
  it('should embed the fingerprint so a re-rendered segment gets a fresh identity', () => {
    const before = cacheFrameAssetId('seq-1', createSegment({ index: 3, fingerprint: '111' }));
    const after = cacheFrameAssetId('seq-1', createSegment({ index: 3, fingerprint: '222' }));

    expect(before).toBe('__cache__seq-1_3_111');
    expect(after).not.toBe(before);
  });
});

describe('cacheFrameOffsetSec', () => {
  /** 30000/1001 — the rate whose grid does not line up with whole seconds. */
  const NTSC_FPS = 30000 / 1001;
  const INTEGER_FPS = 30;

  /** The frame index the decoder resolves an offset to: nearest, not floor. */
  function frameIndexAt(offsetSec: number, fps: number): number {
    return Math.round(offsetSec * fps);
  }

  it('should convert a timeline time into an offset inside the segment file', () => {
    const segment = createSegment({ startSec: 5, endSec: 10 });

    expect(cacheFrameOffsetSec(segment, 7.5, INTEGER_FPS)).toBeCloseTo(2.5, 6);
  });

  it('should never return a negative offset', () => {
    const segment = createSegment({ startSec: 5, endSec: 10 });

    expect(cacheFrameOffsetSec(segment, 4, INTEGER_FPS)).toBe(0);
  });

  it('should resolve a time parked inside the final frame to the last frame the file holds', () => {
    // The decoder addresses by nearest frame and errors out of range instead of
    // saturating, so anything rounding past the end would fail the decode — and
    // a failed decode retires the whole segment as unplayable.
    const segment = createSegment({ startSec: 0, endSec: 5 });
    const quarterFrameBeforeEnd = 5 - 0.25 / NTSC_FPS;

    const offset = cacheFrameOffsetSec(segment, quarterFrameBeforeEnd, NTSC_FPS);

    // The renderer's window is round(0 * fps)..round(5 * fps) = frames 0..149.
    expect(frameIndexAt(offset, NTSC_FPS)).toBe(149);
  });

  it('should clamp the segment end itself onto the last frame', () => {
    const segment = createSegment({ startSec: 0, endSec: 5 });

    expect(frameIndexAt(cacheFrameOffsetSec(segment, 5, NTSC_FPS), NTSC_FPS)).toBe(149);
  });

  it('should address through the frame grid so an NTSC segment start keeps its phase', () => {
    // Segment bounds are whole seconds but the renderer snaps its window to
    // round(t * fps) and rebases the file to zero, so file frame 0 sits up to
    // half a frame away from startSec. Segment 1 starts 0.15 frames late.
    const segment = createSegment({ index: 1, startSec: 5, endSec: 10 });

    const offset = cacheFrameOffsetSec(segment, 7.5, NTSC_FPS);

    expect(offset).toBeCloseTo((Math.round(7.5 * NTSC_FPS) - 150) / NTSC_FPS, 9);
    expect(offset).not.toBeCloseTo(2.5, 6);
  });

  it('should pick the frame the renderer wrote where a naive offset picks its neighbour', () => {
    // Segment 3 starts 0.45 frames early, which is enough to shift the rounding.
    const segment = createSegment({ index: 3, startSec: 15, endSec: 20 });

    const offset = cacheFrameOffsetSec(segment, 17.5, NTSC_FPS);

    expect(frameIndexAt(offset, NTSC_FPS)).toBe(74);
    expect(frameIndexAt(17.5 - 15, NTSC_FPS)).toBe(75);
  });

  it('should keep the grid offset correct where the segment start rounds down', () => {
    // Segment 4 starts 0.4 frames late — the opposite phase to segment 3.
    const segment = createSegment({ index: 4, startSec: 20, endSec: 25 });

    const offset = cacheFrameOffsetSec(segment, 20.05, NTSC_FPS);

    expect(frameIndexAt(offset, NTSC_FPS)).toBe(2);
    expect(frameIndexAt(20.05 - 20, NTSC_FPS)).toBe(1);
  });

  it('should address the only frame of a segment shorter than one frame', () => {
    const segment = createSegment({ startSec: 5, endSec: 5.01 });

    expect(cacheFrameOffsetSec(segment, 5.009, NTSC_FPS)).toBe(0);
  });

  it('should fall back to a continuous offset when the frame rate is unusable', () => {
    const segment = createSegment({ startSec: 5, endSec: 10 });

    expect(cacheFrameOffsetSec(segment, 7.5, 0)).toBeCloseTo(2.5, 6);
    expect(cacheFrameOffsetSec(segment, 10, Number.NaN)).toBeCloseTo(4.999, 6);
  });
});

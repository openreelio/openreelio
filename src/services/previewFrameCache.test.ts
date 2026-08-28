/**
 * Feature: bounded preview frame cache
 *
 * Decoded preview frames are `ImageBitmap`s whose memory lives outside the JS
 * heap and is only released by `close()`. A cache that forgets an entry without
 * closing it leaks that memory for the life of the process, so every path that
 * drops a frame has to close it.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createPreviewFrameKey,
  createPreviewTimeKey,
  PreviewFrameCache,
  type ClosablePreviewFrame,
} from '@/services/previewFrameCache';

interface FakeFrame extends ClosablePreviewFrame {
  close: ReturnType<typeof vi.fn>;
}

/** A stand-in for an `ImageBitmap` that records whether it was released. */
function createFrame(width: number, height: number): FakeFrame {
  return { width, height, close: vi.fn() };
}

describe('PreviewFrameCache', () => {
  it('should return the frame it stored when the key is read back', () => {
    const cache = new PreviewFrameCache<FakeFrame>();
    const frame = createFrame(4, 4);

    cache.set('a', frame);

    expect(cache.get('a')).toBe(frame);
    expect(cache.has('a')).toBe(true);
  });

  it('should report a miss as null rather than throwing', () => {
    const cache = new PreviewFrameCache<FakeFrame>();

    expect(cache.get('absent')).toBeNull();
    expect(cache.getStats().misses).toBe(1);
  });

  it('should close the least recently used frame when the entry bound is exceeded', () => {
    const cache = new PreviewFrameCache<FakeFrame>({ maxEntries: 2 });
    const first = createFrame(2, 2);
    const second = createFrame(2, 2);
    const third = createFrame(2, 2);

    cache.set('first', first);
    cache.set('second', second);
    cache.set('third', third);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(cache.has('first')).toBe(false);
    expect(cache.has('second')).toBe(true);
    expect(cache.has('third')).toBe(true);
    expect(cache.getStats().entries).toBe(2);
  });

  it('should treat a read as use so the least recently used frame is the one evicted', () => {
    const cache = new PreviewFrameCache<FakeFrame>({ maxEntries: 2 });
    const first = createFrame(2, 2);
    const second = createFrame(2, 2);
    const third = createFrame(2, 2);

    cache.set('first', first);
    cache.set('second', second);
    // Reading `first` makes `second` the oldest.
    cache.get('first');
    cache.set('third', third);

    expect(second.close).toHaveBeenCalledTimes(1);
    expect(first.close).not.toHaveBeenCalled();
    expect(cache.has('first')).toBe(true);
  });

  it('should evict by real frame bytes rather than a per-entry guess', () => {
    // Two 100x100 RGBA frames are 40000 bytes each.
    const cache = new PreviewFrameCache<FakeFrame>({
      maxEntries: 100,
      maxBytes: 50_000,
      minEntries: 1,
    });
    const first = createFrame(100, 100);
    const second = createFrame(100, 100);

    cache.set('first', first);
    expect(cache.getStats().bytes).toBe(40_000);

    cache.set('second', second);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(cache.getStats().entries).toBe(1);
    expect(cache.getStats().bytes).toBe(40_000);
  });

  it('should keep the frame it just stored even when that frame alone is over budget', () => {
    const cache = new PreviewFrameCache<FakeFrame>({
      maxEntries: 4,
      maxBytes: 1_000,
      minEntries: 1,
    });
    const oversized = createFrame(100, 100);

    cache.set('oversized', oversized);

    expect(oversized.close).not.toHaveBeenCalled();
    expect(cache.get('oversized')).toBe(oversized);
  });

  it('should close the frame it replaces when a key is written twice', () => {
    const cache = new PreviewFrameCache<FakeFrame>();
    const original = createFrame(2, 2);
    const replacement = createFrame(2, 2);

    cache.set('key', original);
    cache.set('key', replacement);

    expect(original.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(cache.get('key')).toBe(replacement);
  });

  it('should let a pass exceed the byte budget rather than close what it is drawing', () => {
    // The compositor gathers every visible clip's frame and only then draws
    // them, so a later frame in the same pass must not be able to evict — and
    // therefore close — an earlier one it is still holding. Twenty 100x100
    // frames are 800 KB against a 1 KB budget.
    const cache = new PreviewFrameCache<FakeFrame>({
      maxEntries: 50,
      maxBytes: 1_000,
      minEntries: 1,
    });

    cache.beginPass();
    const frames = Array.from({ length: 20 }, () => createFrame(100, 100));
    frames.forEach((frame, index) => {
      cache.set(`frame-${index}`, frame);
      cache.pin(frame);
    });

    for (const frame of frames) {
      expect(frame.close).not.toHaveBeenCalled();
    }
    expect(cache.getStats().entries).toBe(20);
    expect(cache.getStats().bytes).toBeGreaterThan(1_000);
  });

  it('should evict the previous pass once a new one begins', () => {
    const cache = new PreviewFrameCache<FakeFrame>({
      maxEntries: 10,
      maxBytes: 50_000,
      minEntries: 1,
    });
    const first = createFrame(100, 100);
    const second = createFrame(100, 100);

    cache.beginPass();
    cache.set('first', first);
    cache.pin(first);
    expect(first.close).not.toHaveBeenCalled();

    // A new pass releases the last one's protection, so the budget applies again.
    cache.beginPass();
    cache.set('second', second);
    cache.pin(second);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
  });

  it('should stop pinning once a pass reaches the entry ceiling', () => {
    // Otherwise a pass that pinned everything would stop eviction outright and
    // let the cache grow without bound.
    const cache = new PreviewFrameCache<FakeFrame>({ maxEntries: 3 });

    cache.beginPass();
    for (let index = 0; index < 10; index += 1) {
      cache.pin(createFrame(2, 2));
    }

    expect(cache.pinnedCount()).toBe(3);
  });

  it('should close every frame when the cache is cleared', () => {
    const cache = new PreviewFrameCache<FakeFrame>();
    const first = createFrame(2, 2);
    const second = createFrame(2, 2);

    cache.set('first', first);
    cache.set('second', second);
    cache.clear();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(cache.getStats().entries).toBe(0);
    expect(cache.getStats().bytes).toBe(0);
  });

  it('should survive a frame whose close throws', () => {
    const cache = new PreviewFrameCache<FakeFrame>();
    const frame: FakeFrame = {
      width: 2,
      height: 2,
      close: vi.fn(() => {
        throw new Error('already detached');
      }),
    };

    cache.set('key', frame);

    expect(() => cache.clear()).not.toThrow();
  });
});

describe('preview frame cache keys', () => {
  it('should separate the same frame decoded for different canvas sizes', () => {
    expect(createPreviewFrameKey('asset-1', 12, 960, 540)).not.toBe(
      createPreviewFrameKey('asset-1', 12, 480, 270),
    );
  });

  it('should separate the same frame index across assets', () => {
    expect(createPreviewFrameKey('asset-1', 12, 960, 540)).not.toBe(
      createPreviewFrameKey('asset-2', 12, 960, 540),
    );
  });

  it('should not collide a time key with a frame-index key', () => {
    expect(createPreviewTimeKey('asset-1', 12, 960, 540)).not.toBe(
      createPreviewFrameKey('asset-1', 12, 960, 540),
    );
  });
});

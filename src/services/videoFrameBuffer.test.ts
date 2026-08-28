/**
 * Feature: canvas preview frames from the resident decoder
 *
 * The canvas preview no longer reads JPEGs off disk: the Rust core streams raw
 * RGBA from a long-lived FFmpeg and this service turns the reply into something
 * the canvas can draw. Only the Tauri IPC boundary is mocked; the cache, the key
 * derivation and the bitmap creation are the real ones.
 */

import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { previewFrameCache } from '@/services/previewFrameCache';
import { videoFrameBuffer } from '@/services/videoFrameBuffer';

const invokeMock = vi.mocked(invoke);

const TARGET = { maxWidth: 320, maxHeight: 180 };

/** Size of the decoder's wire header. */
const HEADER_BYTES = 32;

/**
 * The bytes the resident decoder puts on the wire: a 32-byte little-endian
 * header followed by `width * height * 4` bytes of RGBA.
 *
 * A `frameIndex` of `null` is what a variable-rate source sends: a zero index
 * with the indexed flag clear.
 */
function encodeFrameReply(options: {
  width: number;
  height: number;
  frameIndex: number | null;
  sourceTime: number;
  fill?: number;
}): ArrayBuffer {
  const { width, height, frameIndex, sourceTime, fill = 0 } = options;
  const pixelBytes = width * height * 4;
  const buffer = new ArrayBuffer(HEADER_BYTES + pixelBytes);
  const view = new DataView(buffer);

  view.setUint32(0, 2, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  view.setUint32(12, frameIndex ?? 0, true);
  view.setFloat64(16, sourceTime, true);
  view.setUint32(24, frameIndex === null ? 0 : 1, true);
  view.setUint32(28, 0, true);
  new Uint8Array(buffer, HEADER_BYTES).fill(fill);

  return buffer;
}

/** An IPC reply the test releases by hand. */
function createDeferredReply(): {
  promise: Promise<ArrayBuffer>;
  resolve: (value: ArrayBuffer) => void;
} {
  let resolve: (value: ArrayBuffer) => void = () => {};
  const promise = new Promise<ArrayBuffer>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

/** A void IPC reply the test releases by hand. */
function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });

  return { promise, resolve };
}

interface StubBitmap {
  width: number;
  height: number;
  close: ReturnType<typeof vi.fn>;
}

const createdBitmaps: StubBitmap[] = [];

beforeEach(() => {
  createdBitmaps.length = 0;
  invokeMock.mockReset();

  // jsdom ships neither, and they are the browser boundary rather than our code.
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public readonly data: Uint8ClampedArray,
        public readonly width: number,
        public readonly height: number,
      ) {}
    },
  );
  vi.stubGlobal('createImageBitmap', (source: { width: number; height: number }) => {
    const bitmap: StubBitmap = { width: source.width, height: source.height, close: vi.fn() };
    createdBitmaps.push(bitmap);
    return Promise.resolve(bitmap);
  });
});

afterEach(async () => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  await videoFrameBuffer.clearAll();
  vi.unstubAllGlobals();
});

describe('VideoFrameBuffer', () => {
  it('should return a drawable carrying the decoded frame size when the decoder replies', async () => {
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );

    const frame = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);

    expect(frame).not.toBeNull();
    expect(frame?.width).toBe(320);
    expect(frame?.height).toBe(180);
  });

  it('should ask the decoder for the canvas box rather than the full source size', async () => {
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );

    await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);

    expect(invokeMock).toHaveBeenCalledWith('get_preview_frame', {
      inputPath: '/tmp/a.mp4',
      timeSec: 0.5,
      maxWidth: 320,
      maxHeight: 180,
    });
  });

  it('should decode once when two nearby times resolve to the same frame', async () => {
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );

    const first = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);
    // 0.501 s at the 30 fps the first reply implies is still frame 15.
    const second = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.501, TARGET);

    expect(second).toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(createdBitmaps).toHaveLength(1);
  });

  it('should decode again for a different frame of the same asset', async () => {
    invokeMock
      .mockResolvedValueOnce(
        encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
      )
      .mockResolvedValueOnce(
        encodeFrameReply({ width: 320, height: 180, frameIndex: 30, sourceTime: 1 }),
      );

    const first = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);
    const second = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 1, TARGET);

    expect(second).not.toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('should share a single decode between concurrent requests for the same frame', async () => {
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );

    const [first, second] = await Promise.all([
      videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET),
      videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET),
    ]);

    expect(second).toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('should resolve to null rather than reject when the decoder fails', async () => {
    invokeMock.mockRejectedValue(new Error('No preview frame at index 900'));

    const frame = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 30, TARGET);

    expect(frame).toBeNull();
    expect(videoFrameBuffer.getStats().failedRequests).toBe(1);
  });

  it('should resolve to null rather than reject when the reply is malformed', async () => {
    invokeMock.mockResolvedValue(new ArrayBuffer(8));

    const frame = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);

    expect(frame).toBeNull();
  });

  it('should resolve to null when the reply carries fewer pixels than its header claims', async () => {
    const truncated = encodeFrameReply({
      width: 320,
      height: 180,
      frameIndex: 15,
      sourceTime: 0.5,
    }).slice(0, HEADER_BYTES + 16);
    invokeMock.mockResolvedValue(truncated);

    const frame = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);

    expect(frame).toBeNull();
  });

  it('should close every cached frame and release the decoders when cleared', async () => {
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );
    await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);
    expect(previewFrameCache.getStats().entries).toBe(1);

    await videoFrameBuffer.clearAll();

    expect(createdBitmaps[0]?.close).toHaveBeenCalledTimes(1);
    expect(previewFrameCache.getStats().entries).toBe(0);
    expect(invokeMock).toHaveBeenCalledWith('release_preview_decoders');
  });

  it('should not hand back a frame it has closed when two clips ask for one picture', async () => {
    // The crossfade shape: the same asset visible twice at times a millisecond
    // apart, on the very first render, before any reply has said how the source
    // is addressed. Both requests converge on one cache entry, and closing the
    // frame the other caller is about to draw is a detached-bitmap crash.
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );

    const [first, second] = await Promise.all([
      videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET),
      videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.501, TARGET),
    ]);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    for (const bitmap of createdBitmaps) {
      if (bitmap === first) {
        expect(bitmap.close).not.toHaveBeenCalled();
      }
    }
    expect(previewFrameCache.getStats().entries).toBe(1);
  });

  it('should not reach the decoder for work queued before a teardown', async () => {
    // The leak this whole mechanism exists to stop: a request that arrives after
    // the pool has been released rebuilds it, and nothing is left to tear the
    // rebuilt one down.
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );

    const queued = [
      videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 1, TARGET),
      videoFrameBuffer.getFrame('asset-2', '/tmp/b.mp4', 2, TARGET),
      videoFrameBuffer.getFrame('asset-3', '/tmp/c.mp4', 3, TARGET),
      videoFrameBuffer.getFrame('asset-4', '/tmp/d.mp4', 4, TARGET),
      videoFrameBuffer.getFrame('asset-5', '/tmp/e.mp4', 5, TARGET),
    ];

    await videoFrameBuffer.clearAll();
    const results = await Promise.all(queued);

    const frameCalls = invokeMock.mock.calls.filter(([command]) => command === 'get_preview_frame');
    const releaseIndex = invokeMock.mock.calls.findIndex(
      ([command]) => command === 'release_preview_decoders',
    );

    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(invokeMock.mock.calls.slice(releaseIndex + 1)).toEqual([]);
    expect(frameCalls.length).toBeLessThanOrEqual(2);
    expect(results.some((frame) => frame === null)).toBe(true);
  });

  it('should discard a frame that arrives after a teardown rather than caching it', async () => {
    const held = createDeferredReply();
    invokeMock.mockImplementation((command: string) =>
      command === 'get_preview_frame' ? held.promise : Promise.resolve(undefined),
    );

    const pending = videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);
    const cleared = videoFrameBuffer.clearAll();

    held.resolve(encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }));

    expect(await pending).toBeNull();
    await cleared;
    expect(previewFrameCache.getStats().entries).toBe(0);
  });

  it('should not reach the decoder for a request that starts during a teardown', async () => {
    // The residual window: a request entering while clearAll is suspended
    // captures the *new* epoch, so every epoch check passes, and it can still
    // invoke after the release — which lazily rebuilds a pool of FFmpeg children
    // with nothing left to reap them.
    const heldRelease = createDeferredVoid();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'release_preview_decoders') {
        return heldRelease.promise;
      }
      return Promise.resolve(
        encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
      );
    });

    const countCalls = (command: string): number =>
      invokeMock.mock.calls.filter(([name]) => name === command).length;

    const cleared = videoFrameBuffer.clearAll();
    // Run out the microtasks until the teardown has actually asked the backend
    // to let go, so the request below is unambiguously inside the window.
    for (let tick = 0; tick < 20 && countCalls('release_preview_decoders') === 0; tick += 1) {
      await Promise.resolve();
    }
    expect(countCalls('release_preview_decoders')).toBe(1);

    const framesBefore = countCalls('get_preview_frame');
    const during = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);
    const framesAfter = countCalls('get_preview_frame');

    heldRelease.resolve();
    await cleared;

    expect(during).toBeNull();
    expect(framesAfter).toBe(framesBefore);
  });

  it('should serve requests again once a teardown has finished', async () => {
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );

    await videoFrameBuffer.clearAll();
    const frame = await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);

    expect(frame).not.toBeNull();
  });

  it('should keep the semaphore exact across a teardown', async () => {
    // Zeroing the permit counter while permits are still held would double-count
    // the returns and leave the buffer permanently over-permissive.
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );

    const queued = Array.from({ length: 6 }, (_, index) =>
      videoFrameBuffer.getFrame(`asset-${index}`, `/tmp/${index}.mp4`, index, TARGET),
    );
    await videoFrameBuffer.clearAll();
    await Promise.all(queued);

    // The counter is private; its effect is observable — a fresh request must
    // still be able to take a permit and complete.
    const after = await videoFrameBuffer.getFrame('asset-9', '/tmp/9.mp4', 1, TARGET);
    expect(after).not.toBeNull();
  });

  it('should pin the frames of one pass so none is closed while it is still drawing', async () => {
    // A pass drawing more clips than the byte budget holds must still get every
    // bitmap it asked for; closing one mid-composite throws on drawImage and the
    // retry hits the same eviction.
    invokeMock.mockImplementation(() =>
      Promise.resolve(
        encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
      ),
    );

    videoFrameBuffer.beginRenderPass();
    const frames = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        videoFrameBuffer.getFrame(`asset-${index}`, `/tmp/${index}.mp4`, 0.5, TARGET),
      ),
    );

    expect(frames.every((frame) => frame !== null)).toBe(true);
    for (const bitmap of createdBitmaps) {
      expect(bitmap.close).not.toHaveBeenCalled();
    }
  });

  it('should address a variable-rate source by time rather than inventing a frame rate', async () => {
    // A reply with no frame index means the source has no index/time mapping.
    // Keying it by a made-up rate would serve one picture for every time.
    invokeMock
      .mockResolvedValueOnce(
        encodeFrameReply({ width: 320, height: 180, frameIndex: null, sourceTime: 0.1 }),
      )
      .mockResolvedValueOnce(
        encodeFrameReply({ width: 320, height: 180, frameIndex: null, sourceTime: 0.2 }),
      );

    const first = await videoFrameBuffer.getFrame('asset-1', '/tmp/vfr.mp4', 0.1, TARGET);
    const second = await videoFrameBuffer.getFrame('asset-1', '/tmp/vfr.mp4', 0.2, TARGET);

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(previewFrameCache.getStats().entries).toBe(2);
  });

  it('should still serve a variable-rate source from cache for a repeated time', async () => {
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: null, sourceTime: 0.1 }),
    );

    const first = await videoFrameBuffer.getFrame('asset-1', '/tmp/vfr.mp4', 0.1, TARGET);
    const second = await videoFrameBuffer.getFrame('asset-1', '/tmp/vfr.mp4', 0.1, TARGET);

    expect(second).toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('should report the frames it is holding', async () => {
    invokeMock.mockResolvedValue(
      encodeFrameReply({ width: 320, height: 180, frameIndex: 15, sourceTime: 0.5 }),
    );

    await videoFrameBuffer.getFrame('asset-1', '/tmp/a.mp4', 0.5, TARGET);
    const stats = videoFrameBuffer.getStats();

    expect(stats.activeAssets).toBe(1);
    expect(stats.bufferedFrames).toBe(1);
    expect(stats.bufferedBytes).toBe(320 * 180 * 4);
  });
});

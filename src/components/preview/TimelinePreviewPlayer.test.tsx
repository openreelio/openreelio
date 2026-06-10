import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { TimelinePreviewPlayer } from './TimelinePreviewPlayer';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import type { Asset, Clip, Sequence, Track } from '@/types';

const frameBufferMock = vi.hoisted(() => ({
  getFrame: vi.fn(),
}));

vi.mock('@/services/videoFrameBuffer', () => ({
  videoFrameBuffer: frameBufferMock,
}));

interface MockCanvasContext {
  canvas: HTMLCanvasElement;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
  fillRect: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  translate: ReturnType<typeof vi.fn>;
  rotate: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
  measureText: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  strokeText: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
let contextByCanvas: WeakMap<HTMLCanvasElement, MockCanvasContext>;

function createMockContext(canvas: HTMLCanvasElement): MockCanvasContext {
  return {
    canvas,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    fillText: vi.fn(),
    strokeText: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
  };
}

function installCanvasMock(): void {
  contextByCanvas = new WeakMap();
  HTMLCanvasElement.prototype.getContext = vi.fn(function getContext(
    this: HTMLCanvasElement,
    contextId: string,
  ) {
    if (contextId !== '2d') {
      return null;
    }

    let context = contextByCanvas.get(this);
    if (!context) {
      context = createMockContext(this);
      contextByCanvas.set(this, context);
    }

    return context as unknown as CanvasRenderingContext2D;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

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

function createVideoAsset(id: string): Asset {
  return {
    id,
    kind: 'video',
    name: `${id}.mp4`,
    uri: `/tmp/${id}.mp4`,
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
  const clip = createClip('clip-1', 'asset-1');

  return {
    id: 'sequence-1',
    name: 'Sequence 1',
    format: {
      canvas: { width: 640, height: 360 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [createVideoTrack('track-1', clip)],
    markers: [],
  };
}

describe('TimelinePreviewPlayer', () => {
  beforeEach(() => {
    installCanvasMock();
    frameBufferMock.getFrame.mockReturnValue(new Promise<string | null>(() => {}));
    usePlaybackStore.getState().reset();
    usePlaybackStore.setState({
      currentTime: 2,
      duration: 10,
      isPlaying: false,
      syncWithTimeline: true,
    });

    const sequence = createSequence();
    const asset = createVideoAsset('asset-1');
    useProjectStore.setState({
      activeSequenceId: sequence.id,
      sequences: new Map([[sequence.id, sequence]]),
      assets: new Map([[asset.id, asset]]),
      stateVersion: 0,
    });
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it('keeps the visible canvas intact while the next frame is still extracting', async () => {
    render(<TimelinePreviewPlayer showControls={false} />);

    await waitFor(() => {
      expect(frameBufferMock.getFrame).toHaveBeenCalledWith('asset-1', '/tmp/asset-1.mp4', 2);
    });

    const visibleCanvas = screen.getByTestId('preview-canvas') as HTMLCanvasElement;
    const visibleContext = contextByCanvas.get(visibleCanvas);

    expect(visibleContext).toBeDefined();
    expect(visibleContext!.fillRect).not.toHaveBeenCalled();
    expect(visibleContext!.clearRect).not.toHaveBeenCalled();
    expect(visibleContext!.drawImage).not.toHaveBeenCalled();
  });

  it('reports the visible preview canvas lifecycle for finishing tools', async () => {
    const onPreviewCanvasChange = vi.fn();
    const { unmount } = render(
      <TimelinePreviewPlayer showControls={false} onPreviewCanvasChange={onPreviewCanvasChange} />,
    );

    await waitFor(() => {
      expect(onPreviewCanvasChange).toHaveBeenCalledWith(screen.getByTestId('preview-canvas'));
    });

    unmount();

    expect(onPreviewCanvasChange).toHaveBeenLastCalledWith(null);
  });

  it('uses the underlying media clip for frame extraction when a text clip is on the top track', async () => {
    const textClip = createClip('text-clip', '__text__title');
    const baseClip = createClip('base-clip', 'asset-1');
    const sequence = {
      ...createSequence(),
      tracks: [createVideoTrack('text-track', textClip), createVideoTrack('base-track', baseClip)],
    };

    useProjectStore.setState({
      activeSequenceId: sequence.id,
      sequences: new Map([[sequence.id, sequence]]),
    });

    render(<TimelinePreviewPlayer showControls={false} />);

    await waitFor(() => {
      expect(frameBufferMock.getFrame).toHaveBeenCalledWith('asset-1', '/tmp/asset-1.mp4', 2);
    });

    expect(frameBufferMock.getFrame).not.toHaveBeenCalledWith(
      '__text__title',
      expect.anything(),
      expect.anything(),
    );
  });

  it('coalesces rapid render requests while frame extraction is pending', async () => {
    const firstExtraction = createDeferred<string | null>();
    frameBufferMock.getFrame
      .mockImplementationOnce(() => firstExtraction.promise)
      .mockReturnValue(new Promise<string | null>(() => {}));

    render(<TimelinePreviewPlayer showControls={false} />);

    await waitFor(() => {
      expect(frameBufferMock.getFrame).toHaveBeenCalledWith('asset-1', '/tmp/asset-1.mp4', 2);
    });

    act(() => {
      usePlaybackStore.setState({ currentTime: 3 });
    });
    act(() => {
      usePlaybackStore.setState({ currentTime: 4 });
    });

    expect(frameBufferMock.getFrame).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstExtraction.resolve(null);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(frameBufferMock.getFrame).toHaveBeenCalledTimes(2);
    });

    expect(frameBufferMock.getFrame).toHaveBeenLastCalledWith('asset-1', '/tmp/asset-1.mp4', 4);
    expect(frameBufferMock.getFrame).not.toHaveBeenCalledWith('asset-1', '/tmp/asset-1.mp4', 3);
  });
});

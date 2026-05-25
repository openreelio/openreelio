import { describe, expect, it } from 'vitest';
import type { Asset } from '@/types';
import type { RenderGraph, VisualRenderLayer } from '@/bindings';
import {
  getActiveMediaVisualLayers,
  getActiveVisualLayers,
  getGraphLayerSourceTime,
  getTopmostVisualLayer,
  isVisualLayerActiveAtTime,
} from './renderGraphLayers';

function createMediaLayer(overrides: Partial<VisualRenderLayer>): VisualRenderLayer {
  return {
    layerIndex: 0,
    trackId: 'track-1',
    trackKind: 'video',
    trackIndex: 0,
    clipId: 'clip-1',
    timelineInSec: 0,
    timelineOutSec: 10,
    timelineInFrame: 0,
    timelineOutFrame: 300,
    durationFrames: 300,
    sourceInSec: 5,
    sourceOutSec: 15,
    sourceInFrame: 150,
    sourceOutFrame: 450,
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    blendMode: 'normal',
    effects: [],
    source: { type: 'media', assetId: 'asset-1' },
    ...overrides,
  };
}

function createGraph(layers: VisualRenderLayer[]): RenderGraph {
  return {
    graphVersion: 1,
    sequenceId: 'seq-1',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    durationSec: 20,
    durationFrames: 600,
    visualLayers: layers,
    audioLayers: [],
  };
}

function createAsset(id: string): Asset {
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

describe('renderGraphLayers', () => {
  it('should use half-open layer timing for active checks', () => {
    const layer = createMediaLayer({ timelineInSec: 2, timelineOutSec: 5 });

    expect(isVisualLayerActiveAtTime(layer, 1.999)).toBe(false);
    expect(isVisualLayerActiveAtTime(layer, 2)).toBe(true);
    expect(isVisualLayerActiveAtTime(layer, 4.999)).toBe(true);
    expect(isVisualLayerActiveAtTime(layer, 5)).toBe(false);
  });

  it('should return active layers in graph compositor order', () => {
    const back = createMediaLayer({ layerIndex: 0, clipId: 'back', trackIndex: 2 });
    const front = createMediaLayer({ layerIndex: 1, clipId: 'front', trackIndex: 0 });
    const graph = createGraph([back, front]);

    const active = getActiveVisualLayers(graph, 1);

    expect(active.map((layer) => layer.clipId)).toEqual(['back', 'front']);
    expect(getTopmostVisualLayer(active)?.clipId).toBe('front');
  });

  it('should filter active media layers with resolved assets', () => {
    const media = createMediaLayer({
      clipId: 'media',
      source: { type: 'media', assetId: 'asset-1' },
    });
    const text = createMediaLayer({
      clipId: 'text',
      source: { type: 'text', assetId: 'text-1', renderSpec: null, textData: null },
    });
    const graph = createGraph([media, text]);
    const assets = new Map([['asset-1', createAsset('asset-1')]]);

    const active = getActiveMediaVisualLayers(graph, assets, 1);

    expect(active).toHaveLength(1);
    const [first] = active;
    expect(first).toBeDefined();
    expect(first!.layer.clipId).toBe('media');
    expect(first!.asset).toBeDefined();
    expect(first!.asset!.id).toBe('asset-1');
  });

  it('should compute graph layer source time from timeline offset', () => {
    const layer = createMediaLayer({ timelineInSec: 10, sourceInSec: 4 });

    expect(getGraphLayerSourceTime(layer, 12.5)).toBe(6.5);
  });
});

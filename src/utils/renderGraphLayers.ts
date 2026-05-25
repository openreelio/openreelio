import type { Asset, TrackKind } from '@/types';
import type { RenderGraph, VisualRenderLayer } from '@/bindings';

export interface ActiveVisualLayer {
  layer: VisualRenderLayer;
  asset?: Asset;
}

export interface ActiveVisualLayerOptions {
  trackKinds?: readonly TrackKind[];
  requireMediaAsset?: boolean;
}

function isMediaLayer(layer: VisualRenderLayer): boolean {
  return layer.source.type === 'media';
}

export function isVisualLayerActiveAtTime(layer: VisualRenderLayer, timeSec: number): boolean {
  return (
    Number.isFinite(timeSec) && timeSec >= layer.timelineInSec && timeSec < layer.timelineOutSec
  );
}

export function getActiveVisualLayers(
  graph: RenderGraph | null | undefined,
  timeSec: number,
  options: ActiveVisualLayerOptions = {},
): VisualRenderLayer[] {
  if (!graph || !Number.isFinite(timeSec)) {
    return [];
  }

  const allowedTrackKinds = options.trackKinds ? new Set(options.trackKinds) : null;

  return graph.visualLayers.filter((layer) => {
    if (allowedTrackKinds && !allowedTrackKinds.has(layer.trackKind)) {
      return false;
    }

    if (options.requireMediaAsset && !isMediaLayer(layer)) {
      return false;
    }

    return isVisualLayerActiveAtTime(layer, timeSec);
  });
}

export function getActiveMediaVisualLayers(
  graph: RenderGraph | null | undefined,
  assets: Map<string, Asset>,
  timeSec: number,
  options: Omit<ActiveVisualLayerOptions, 'requireMediaAsset'> = {},
): ActiveVisualLayer[] {
  return getActiveVisualLayers(graph, timeSec, {
    ...options,
    requireMediaAsset: true,
  })
    .map((layer): ActiveVisualLayer | null => {
      if (layer.source.type !== 'media') {
        return null;
      }

      const asset = assets.get(layer.source.assetId);
      if (!asset) {
        return null;
      }

      return { layer, asset };
    })
    .filter((entry): entry is ActiveVisualLayer => entry !== null);
}

export function getTopmostVisualLayer(
  layers: readonly VisualRenderLayer[],
): VisualRenderLayer | null {
  return layers.length > 0 ? layers[layers.length - 1] : null;
}

export function getGraphLayerSourceTime(layer: VisualRenderLayer, timelineTimeSec: number): number {
  const timelineOffset = Math.max(0, timelineTimeSec - layer.timelineInSec);
  return layer.sourceInSec + timelineOffset;
}

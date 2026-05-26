import { describe, expect, it } from 'vitest';
import type { AssetAnnotation } from '@/bindings';
import { createSubtitleTextClipData, createTitleTextClipData, type Sequence } from '@/types';
import {
  annotationToTextPlacementObstacles,
  parseTextPlacementOptions,
  resolveSmartTextPlacement,
} from './textPlacement';

function sequence(): Sequence {
  return {
    id: 'seq-1',
    name: 'Main',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [],
    markers: [],
  };
}

function annotationWithFaceAtBottom(): AssetAnnotation {
  return {
    version: '1',
    assetId: 'asset-1',
    assetHash: 'hash',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    analysis: {
      faces: {
        provider: 'google_cloud',
        analyzedAt: '2026-01-01T00:00:00Z',
        config: {},
        results: [
          {
            timeSec: 2,
            confidence: 0.95,
            boundingBox: { left: 0.25, top: 0.72, width: 0.5, height: 0.2 },
            emotions: [],
          },
        ],
      },
    },
  };
}

describe('textPlacement', () => {
  it('should move subtitle placement away from detected lower-frame faces', () => {
    const textData = createSubtitleTextClipData('Readable subtitle');
    const obstacles = annotationToTextPlacementObstacles(annotationWithFaceAtBottom(), 2, 0.5);

    const decision = resolveSmartTextPlacement({
      textData,
      sequence: sequence(),
      options: parseTextPlacementOptions({ placementIntent: 'subtitle' }),
      obstacles,
      existingText: [],
    });

    expect(decision.candidate).toBe('upper_center');
    expect(decision.position.y).toBeLessThan(0.3);
    expect(decision.obstacleCount).toBe(1);
  });

  it('should avoid an existing title when auto-placing another title', () => {
    const textData = createTitleTextClipData('Second title');
    const existingTitle = createTitleTextClipData('Main title');

    const decision = resolveSmartTextPlacement({
      textData,
      sequence: sequence(),
      options: parseTextPlacementOptions({ placementIntent: 'title' }),
      obstacles: [],
      existingText: [{ textData: existingTitle, weight: 8 }],
    });

    expect(decision.candidate).not.toBe('center');
  });
});

import { describe, it, expect } from 'vitest';
import { extractTextDataFromClipWithMap } from './textRenderer';
import type { Clip, TextClipData } from '@/types';

function createClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    assetId: 'asset-1',
    range: { sourceInSec: 0, sourceOutSec: 5 },
    place: { timelineInSec: 0, durationSec: 5 },
    transform: {
      position: { x: 0.5, y: 0.5 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
    ...overrides,
  };
}

describe('extractTextDataFromClipWithMap', () => {
  it('should return undefined when clip is not a text clip', () => {
    const clip = createClip({ assetId: 'asset-video-1' });
    const result = extractTextDataFromClipWithMap(clip);
    expect(result).toBeUndefined();
  });

  it('should prefer resolved text data map for text clips', () => {
    const clip = createClip({ id: 'text-clip-1', assetId: '__text__main' });
    const resolved: TextClipData = {
      content: 'Resolved content',
      style: {
        fontFamily: 'Arial',
        fontSize: 48,
        color: '#FFFFFF',
        alignment: 'center',
        bold: false,
        italic: false,
        underline: false,
        backgroundPadding: 10,
        lineHeight: 1.2,
        letterSpacing: 0,
      },
      position: { x: 0.2, y: 0.3 },
      rotation: 0,
      opacity: 1,
    };

    const result = extractTextDataFromClipWithMap(clip, new Map([[clip.id, resolved]]));

    expect(result).toEqual(resolved);
  });

  it('should fallback to label content for text clips without resolved data', () => {
    const clip = createClip({
      assetId: '__text__main',
      label: 'Text: Hello fallback',
    });

    const result = extractTextDataFromClipWithMap(clip);

    expect(result?.content).toBe('Hello fallback');
    expect(result?.style.fontFamily).toBe('Arial');
  });
});

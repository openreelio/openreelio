import { describe, it, expect } from 'vitest';
import {
  applyClipTransformToEditableTextData,
  applyClipTransformToRenderedTextData,
  extractTextDataFromClipWithMap,
  getTextFontWeightNumber,
} from './textRenderer';
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

describe('getTextFontWeightNumber', () => {
  it('should preserve numeric font weights', () => {
    expect(getTextFontWeightNumber({ fontWeight: 650, bold: false })).toBe(650);
  });

  it('should fall back to bold state when numeric weight is missing', () => {
    expect(getTextFontWeightNumber({ bold: true })).toBe(700);
    expect(getTextFontWeightNumber({ bold: false })).toBe(400);
  });

  it('should keep legacy bold text visually bold when weight defaults to normal', () => {
    expect(getTextFontWeightNumber({ fontWeight: 400, bold: true })).toBe(700);
  });
});

describe('applyClipTransformToEditableTextData', () => {
  it('should sync position and rotation without baking scale into font size', () => {
    const clip = createClip({
      assetId: '__text__main',
      transform: {
        position: { x: 0.25, y: 0.75 },
        scale: { x: 2, y: 2 },
        rotationDeg: 15,
        anchor: { x: 0.5, y: 0.5 },
      },
    });
    const textData = extractTextDataFromClipWithMap(
      clip,
      new Map([
        [
          clip.id,
          {
            content: 'Editable',
            style: {
              fontFamily: 'Arial',
              fontSize: 48,
              fontWeight: 400,
              color: '#FFFFFF',
              backgroundPadding: 10,
              alignment: 'center',
              bold: false,
              italic: false,
              underline: false,
              lineHeight: 1.2,
              letterSpacing: 0,
            },
            position: { x: 0.5, y: 0.5 },
            rotation: 0,
            opacity: 1,
          },
        ],
      ]),
    );

    expect(textData).toBeDefined();
    const result = applyClipTransformToEditableTextData(clip, textData!);

    expect(result.position).toEqual({ x: 0.25, y: 0.75 });
    expect(result.rotation).toBe(15);
    expect(result.style.fontSize).toBe(48);
  });

  it('should treat mirrored text and clip opacity as a single opacity source', () => {
    const clip = createClip({ assetId: '__text__main', opacity: 0.5 });
    const textData = extractTextDataFromClipWithMap(clip)!;
    const result = applyClipTransformToEditableTextData(clip, {
      ...textData,
      opacity: 0.5,
    });

    expect(result.opacity).toBe(0.5);
  });

  it('should keep semantic text position when only clip opacity differs', () => {
    const clip = createClip({ assetId: '__text__main', opacity: 0.5 });
    const textData = extractTextDataFromClipWithMap(clip)!;
    const result = applyClipTransformToEditableTextData(clip, {
      ...textData,
      position: { x: 0.2, y: 0.8 },
      opacity: 1,
    });

    expect(result.position).toEqual({ x: 0.2, y: 0.8 });
    expect(result.opacity).toBe(0.5);
  });
});

describe('applyClipTransformToRenderedTextData', () => {
  it('should scale visible text styling for preview rendering', () => {
    const clip = createClip({
      assetId: '__text__main',
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 2, y: 1 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      },
    });
    const textData = extractTextDataFromClipWithMap(clip)!;
    const result = applyClipTransformToRenderedTextData(clip, {
      ...textData,
      style: {
        ...textData.style,
        fontSize: 40,
        backgroundPadding: 8,
        letterSpacing: 2,
      },
      shadow: { color: '#000000', offsetX: 2, offsetY: 4, blur: 2 },
      outline: { color: '#000000', width: 2 },
    });

    expect(result.style.fontSize).toBe(60);
    expect(result.style.backgroundPadding).toBe(12);
    expect(result.style.letterSpacing).toBe(3);
    expect(result.shadow).toEqual({ color: '#000000', offsetX: 3, offsetY: 6, blur: 3 });
    expect(result.outline).toEqual({ color: '#000000', width: 3 });
  });
});

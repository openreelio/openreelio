/**
 * Transform overlay geometry helpers.
 *
 * Resolves the clip transform and the source box the transform overlay draws,
 * including the text-clip special cases (canvas-space measurement and the
 * alignment-driven horizontal anchor). Kept out of the component so the
 * component stays a thin adapter between the store and react-moveable.
 */

import type { Transform, TextClipAlignment, TextClipData, Asset, Clip } from '@/types';
import { isTextClip } from '@/types';
import { extractTextDataFromClipWithMap, getTextFontWeightNumber } from '@/utils/textRenderer';
import { scaleFontSizeToCanvas, type PreviewSource } from '@/utils/previewCoords';

const DEFAULT_TEXT_BOUNDS = { width: 320, height: 96 };

let measurementCanvas: HTMLCanvasElement | null = null;

function getMeasurementContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') {
    return null;
  }

  if (!measurementCanvas) {
    measurementCanvas = document.createElement('canvas');
  }

  return measurementCanvas.getContext('2d');
}

/** The transform every clip falls back to when it has none of its own. */
export function getDefaultTransform(): Transform {
  return {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1.0, y: 1.0 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
  };
}

function isIdentityTransform(transform: Transform): boolean {
  return (
    Math.abs(transform.position.x - 0.5) < 0.0001 &&
    Math.abs(transform.position.y - 0.5) < 0.0001 &&
    Math.abs(transform.scale.x - 1) < 0.0001 &&
    Math.abs(transform.scale.y - 1) < 0.0001 &&
    Math.abs(transform.rotationDeg) < 0.0001 &&
    Math.abs(transform.anchor.x - 0.5) < 0.0001 &&
    Math.abs(transform.anchor.y - 0.5) < 0.0001
  );
}

function getTextAnchorX(alignment: TextClipAlignment): number {
  if (alignment === 'left') {
    return 0;
  }

  if (alignment === 'right') {
    return 1;
  }

  return 0.5;
}

/**
 * Applies the text-clip overrides to a clip transform.
 *
 * A text clip that still carries the identity transform is positioned by its
 * own `textData`, and its horizontal anchor always follows the text alignment
 * so left/right aligned text stays under the overlay box.
 */
export function resolveTransformForTextOverlay(
  clipTransform: Transform,
  textData: TextClipData | undefined,
): Transform {
  if (!textData) {
    return clipTransform;
  }

  const baseTransform = isIdentityTransform(clipTransform)
    ? {
        ...clipTransform,
        position: { ...textData.position },
        rotationDeg: textData.rotation,
      }
    : clipTransform;

  return {
    ...baseTransform,
    anchor: {
      ...baseTransform.anchor,
      x: getTextAnchorX(textData.style.alignment),
      y: 0.5,
    },
  };
}

function measureLineWidth(
  ctx: CanvasRenderingContext2D,
  line: string,
  letterSpacing: number,
): number {
  const baseWidth = ctx.measureText(line).width;
  if (letterSpacing === 0 || line.length <= 1) {
    return baseWidth;
  }

  return baseWidth + (line.length - 1) * letterSpacing;
}

/** Measures a text clip's drawn box in canvas-space pixels. */
export function measureTextBounds(
  textData: TextClipData,
  canvasHeight: number,
): { width: number; height: number } {
  const ctx = getMeasurementContext();
  if (!ctx) {
    return DEFAULT_TEXT_BOUNDS;
  }

  const lines = textData.content.split('\n');
  if (lines.length === 1 && lines[0] === '') {
    return DEFAULT_TEXT_BOUNDS;
  }

  const scaledFontSize = scaleFontSizeToCanvas(textData.style.fontSize, canvasHeight, 1);
  const fontStyle = textData.style.italic ? 'italic ' : '';
  const fontWeight = `${getTextFontWeightNumber(textData.style)} `;
  ctx.font = `${fontStyle}${fontWeight}${scaledFontSize}px ${textData.style.fontFamily}`;

  const maxLineWidth = lines.reduce((maxWidth, line) => {
    return Math.max(maxWidth, measureLineWidth(ctx, line, textData.style.letterSpacing));
  }, 0);

  const lineHeight = scaledFontSize * textData.style.lineHeight;
  const textHeight = lineHeight * lines.length;

  const backgroundPadding = textData.style.backgroundColor
    ? textData.style.backgroundPadding * 2
    : 0;
  const outlinePadding = textData.outline?.width ? textData.outline.width * 2 : 0;
  const shadowPaddingX = textData.shadow
    ? (Math.abs(textData.shadow.offsetX) + textData.shadow.blur) * 2
    : 0;
  const shadowPaddingY = textData.shadow
    ? (Math.abs(textData.shadow.offsetY) + textData.shadow.blur) * 2
    : 0;

  return {
    width: Math.max(
      12,
      Math.ceil(maxLineWidth + backgroundPadding + outlinePadding + shadowPaddingX),
    ),
    height: Math.max(
      12,
      Math.ceil(textHeight + backgroundPadding + outlinePadding + shadowPaddingY),
    ),
  };
}

/** The transform and source box the overlay should draw for a clip. */
export interface ResolvedOverlayGeometry {
  /** Transform in wire format, with text overrides applied. */
  transform: Transform;
  /** Source box the transform scales. */
  source: PreviewSource;
  /** Whether the clip is a text clip (drives uniform-only resizing). */
  isText: boolean;
}

/**
 * Resolves the transform and source box for the overlay.
 *
 * @param clip - The selected clip.
 * @param clipTransform - Transform sampled at the current playhead time.
 * @param assets - Asset map used for intrinsic media dimensions.
 * @param textClipDataById - Text clip payloads for the active sequence.
 * @param canvasWidth - Sequence canvas width in pixels.
 * @param canvasHeight - Sequence canvas height in pixels.
 */
export function resolveOverlayGeometry(
  clip: Clip,
  clipTransform: Transform,
  assets: Map<string, Asset>,
  textClipDataById: ReadonlyMap<string, TextClipData>,
  canvasWidth: number,
  canvasHeight: number,
): ResolvedOverlayGeometry {
  const isText = isTextClip(clip.assetId);
  const textData = isText ? extractTextDataFromClipWithMap(clip, textClipDataById) : undefined;
  const transform = resolveTransformForTextOverlay(clipTransform, textData);
  const measuredTextBounds = textData ? measureTextBounds(textData, canvasHeight) : null;
  const asset = assets.get(clip.assetId);

  return {
    transform,
    source: {
      width: Math.max(1, measuredTextBounds?.width ?? asset?.video?.width ?? canvasWidth),
      height: Math.max(1, measuredTextBounds?.height ?? asset?.video?.height ?? canvasHeight),
      // Text bounds are already canvas-space pixels, so they skip the contain-fit.
      isCanvasSpace: measuredTextBounds !== null,
    },
    isText,
  };
}

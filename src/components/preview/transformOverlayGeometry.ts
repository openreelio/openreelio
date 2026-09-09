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
import {
  extractTextDataFromClipWithMap,
  getTextFontWeightNumber,
  splitIntoDrawableCharacters,
} from '@/utils/textRenderer';
import { scaleFontSizeToCanvas, type PreviewSource } from '@/utils/previewCoords';
import { cssFontShorthand } from '@/utils/previewFonts';

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

/**
 * Measures one drawn line exactly the way `renderTextToCanvas` draws it.
 *
 * With no letter spacing the renderer draws the line as a single run, so the
 * whole-string measurement is the right one. With letter spacing it stops doing
 * that: `drawTextWithLetterSpacing` splits the line into drawable characters
 * and lays them out one at a time, so the covered width is the sum of the
 * per-character advances plus one gap between each pair — no whole-run kerning,
 * and one gap per *code point*.
 *
 * Measuring the whole string and adding `line.length - 1` gaps instead counts
 * an astral emoji as the two UTF-16 code units it is stored in, so a line like
 * `Cut 🎬🔥🎉` gained an extra gap per emoji and kept kerning the renderer had
 * already dropped. The box came out wider than the glyphs and the right handle
 * floated off the text. `measureCaptionLineWidth` in `TimelinePreviewPlayer`
 * measures the caption pass the same way, for the same reason.
 */
function measureLineWidth(
  ctx: CanvasRenderingContext2D,
  line: string,
  letterSpacing: number,
): number {
  if (letterSpacing === 0) {
    return ctx.measureText(line).width;
  }

  const characters = splitIntoDrawableCharacters(line);
  if (characters.length <= 1) {
    return ctx.measureText(line).width;
  }

  return (
    characters.reduce((width, character) => width + ctx.measureText(character).width, 0) +
    (characters.length - 1) * letterSpacing
  );
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
  // The same builder `renderTextToCanvas` draws with. These handles frame the
  // glyphs that function paints, so a family resolved differently here than
  // there — the stored `Arial` placeholder is the case that bites — measures in
  // one face while the renderer draws in another and puts the box somewhere
  // other than the text. Sharing one builder is what keeps the resolution, the
  // quoting and the clamping identical on both paths.
  ctx.font = cssFontShorthand({
    fontFamily: textData.style.fontFamily,
    fontSizePx: scaledFontSize,
    fontWeight: getTextFontWeightNumber(textData.style),
    italic: textData.style.italic,
  });

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

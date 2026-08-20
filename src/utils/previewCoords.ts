/**
 * Preview coordinate math.
 *
 * Pure, React-free conversions between the three coordinate spaces every
 * preview surface shares:
 *
 * - normalized clip space — `Transform.position` / `Transform.anchor`, 0..1
 * - canvas space          — pixels on the sequence canvas (e.g. 1920x1080)
 * - screen space          — pixels inside the preview container, after zoom
 *                           (`displayScale`) and pan (`panX` / `panY`)
 *
 * The ground truth is the canvas renderer in `TimelinePreviewPlayer`:
 * `translate(position * canvas)` -> `rotate(rotationDeg)` -> `drawImage(-anchorOffset)`.
 * Rotation therefore happens about the ANCHOR point, not about the box center.
 * `clipBoundsFromTransform` and `transformFromScreenRect` are exact inverses of
 * each other so an overlay can be driven from a transform and a transform can be
 * recovered from the overlay rectangle without drift.
 */

import type { Point2D, Transform } from '@/types';

// =============================================================================
// Constants
// =============================================================================

/**
 * Reference canvas height that all authored pixel sizes (font sizes, outline
 * widths, padding) are expressed against. Matches the ASS `PlayResY` contract
 * used by the burn-in renderer, so DOM overlays, the canvas renderer and the
 * exported subtitles agree on scale.
 */
export const PLAY_RES_Y = 1080;

/** Lower bound applied to `Transform.scale` so a clip can never collapse. */
export const MIN_TRANSFORM_SCALE = 0.1;

// =============================================================================
// Types
// =============================================================================

/** Geometry of a preview surface: its canvas, its container, zoom and pan. */
export interface PreviewViewport {
  /** Sequence canvas width in canvas pixels. */
  canvasWidth: number;
  /** Sequence canvas height in canvas pixels. */
  canvasHeight: number;
  /** Container width in screen pixels. */
  containerWidth: number;
  /** Container height in screen pixels. */
  containerHeight: number;
  /** Screen pixels per canvas pixel (zoom / letterbox fit). */
  displayScale: number;
  /** Horizontal pan offset in screen pixels. */
  panX: number;
  /** Vertical pan offset in screen pixels. */
  panY: number;
}

/** Intrinsic size of the media a clip draws. */
export interface PreviewSource {
  /** Source width in pixels. */
  width: number;
  /** Source height in pixels. */
  height: number;
  /**
   * When true the source is already measured in canvas-space pixels (text
   * clips), so the letterbox contain-fit is skipped and the base scale is 1.
   */
  isCanvasSpace?: boolean;
}

/** Axis-aligned screen rectangle of a clip, plus its rotation about the anchor. */
export interface ClipScreenBounds {
  /** Left edge of the unrotated box, in screen pixels. */
  left: number;
  /** Top edge of the unrotated box, in screen pixels. */
  top: number;
  /** Box width in screen pixels. */
  width: number;
  /** Box height in screen pixels. */
  height: number;
  /** Geometric center of the unrotated box, in screen pixels. */
  centerX: number;
  /** Geometric center of the unrotated box, in screen pixels. */
  centerY: number;
  /** Rotation in degrees, applied about the anchor point. */
  rotationDeg: number;
  /** Normalized anchor (0..1) inside the box; also the rotation origin. */
  anchor: Point2D;
  /** Anchor point in screen pixels (the rotation origin). */
  anchorScreenX: number;
  /** Anchor point in screen pixels (the rotation origin). */
  anchorScreenY: number;
}

/** The subset of {@link ClipScreenBounds} needed to recover a transform. */
export interface ClipScreenRect {
  /** Left edge of the unrotated box, in screen pixels. */
  left: number;
  /** Top edge of the unrotated box, in screen pixels. */
  top: number;
  /** Box width in screen pixels. */
  width: number;
  /** Box height in screen pixels. */
  height: number;
  /** Rotation in degrees, applied about the anchor point. */
  rotationDeg: number;
}

// =============================================================================
// Scalars
// =============================================================================

/** Clamps a value into the 0..1 normalized range. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Scales an authored font size (expressed against {@link PLAY_RES_Y}) to the
 * height of the canvas it is drawn on.
 *
 * @param fontSize - Authored font size in reference pixels.
 * @param canvasHeight - Target canvas height in pixels.
 * @param minPx - Lower bound for the result; defaults to no lower bound.
 */
export function scaleFontSizeToCanvas(
  fontSize: number,
  canvasHeight: number,
  minPx = 0,
): number {
  const safeFontSize = Number.isFinite(fontSize) ? fontSize : 0;
  const safeCanvasHeight = Number.isFinite(canvasHeight) ? canvasHeight : 0;
  return Math.max(minPx, (safeFontSize * safeCanvasHeight) / PLAY_RES_Y);
}

/**
 * Uniform scale that fits a source box inside the canvas without cropping
 * (CSS `object-fit: contain`).
 *
 * @returns Canvas pixels per source pixel; 1 when any input is unusable.
 */
export function computeContainFit(
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(canvasWidth) ||
    !Number.isFinite(canvasHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return 1;
  }

  return Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
}

/**
 * Base scale applied to a source before the clip transform.
 *
 * Canvas-space sources (text) are already sized in canvas pixels and skip the
 * contain-fit entirely.
 */
export function resolveBaseScale(source: PreviewSource, viewport: PreviewViewport): number {
  if (source.isCanvasSpace) {
    return 1;
  }

  return computeContainFit(
    source.width,
    source.height,
    viewport.canvasWidth,
    viewport.canvasHeight,
  );
}

/**
 * Whether a viewport can be used for reversible coordinate math.
 *
 * A zero or non-finite `displayScale` (an unmeasured container) makes the
 * screen -> canvas direction undefined, so callers must not commit edits.
 */
export function isViewportUsable(viewport: PreviewViewport): boolean {
  return (
    Number.isFinite(viewport.canvasWidth) &&
    viewport.canvasWidth > 0 &&
    Number.isFinite(viewport.canvasHeight) &&
    viewport.canvasHeight > 0 &&
    Number.isFinite(viewport.displayScale) &&
    viewport.displayScale > 0
  );
}

function safeDisplayScale(viewport: PreviewViewport): number {
  return Number.isFinite(viewport.displayScale) && viewport.displayScale > 0
    ? viewport.displayScale
    : 1;
}

function safePan(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

// =============================================================================
// Point mapping
// =============================================================================

/** Maps a canvas-space point to screen space (zoom about the canvas center, then pan). */
export function canvasToScreen(point: Point2D, viewport: PreviewViewport): Point2D {
  const scale = safeDisplayScale(viewport);

  return {
    x:
      viewport.containerWidth / 2 +
      (point.x - viewport.canvasWidth / 2) * scale +
      safePan(viewport.panX),
    y:
      viewport.containerHeight / 2 +
      (point.y - viewport.canvasHeight / 2) * scale +
      safePan(viewport.panY),
  };
}

/** Exact inverse of {@link canvasToScreen}. */
export function screenToCanvas(point: Point2D, viewport: PreviewViewport): Point2D {
  const scale = safeDisplayScale(viewport);

  return {
    x:
      (point.x - viewport.containerWidth / 2 - safePan(viewport.panX)) / scale +
      viewport.canvasWidth / 2,
    y:
      (point.y - viewport.containerHeight / 2 - safePan(viewport.panY)) / scale +
      viewport.canvasHeight / 2,
  };
}

// =============================================================================
// Transform <-> rectangle
// =============================================================================

function fittedSize(
  source: PreviewSource,
  viewport: PreviewViewport,
): { width: number; height: number } {
  const baseScale = resolveBaseScale(source, viewport);
  return {
    width: Math.max(1, source.width) * baseScale,
    height: Math.max(1, source.height) * baseScale,
  };
}

/**
 * Forward map: clip transform -> screen rectangle.
 *
 * The returned box is the UNROTATED rectangle; `rotationDeg` is applied about
 * `anchor` (equivalently, about `anchorScreenX` / `anchorScreenY`), matching the
 * canvas renderer.
 */
export function clipBoundsFromTransform(
  transform: Transform,
  source: PreviewSource,
  viewport: PreviewViewport,
): ClipScreenBounds {
  const fitted = fittedSize(source, viewport);
  const scale = safeDisplayScale(viewport);

  const clipCanvasWidth = fitted.width * transform.scale.x;
  const clipCanvasHeight = fitted.height * transform.scale.y;

  // The transform position is the anchor point, expressed in normalized canvas space.
  const anchorCanvas = {
    x: transform.position.x * viewport.canvasWidth,
    y: transform.position.y * viewport.canvasHeight,
  };

  const topLeftCanvas = {
    x: anchorCanvas.x - clipCanvasWidth * transform.anchor.x,
    y: anchorCanvas.y - clipCanvasHeight * transform.anchor.y,
  };

  const topLeftScreen = canvasToScreen(topLeftCanvas, viewport);
  const anchorScreen = canvasToScreen(anchorCanvas, viewport);

  const width = clipCanvasWidth * scale;
  const height = clipCanvasHeight * scale;

  return {
    left: topLeftScreen.x,
    top: topLeftScreen.y,
    width,
    height,
    centerX: topLeftScreen.x + width / 2,
    centerY: topLeftScreen.y + height / 2,
    rotationDeg: transform.rotationDeg,
    anchor: { x: transform.anchor.x, y: transform.anchor.y },
    anchorScreenX: anchorScreen.x,
    anchorScreenY: anchorScreen.y,
  };
}

/**
 * Inverse map: screen rectangle -> clip transform.
 *
 * The anchor is not editable through the overlay, so it is carried over from
 * `baseTransform`. `position` is clamped to 0..1 (matching the backend
 * sanitizer) and `scale` is floored at {@link MIN_TRANSFORM_SCALE}.
 */
export function transformFromScreenRect(
  rect: ClipScreenRect,
  source: PreviewSource,
  viewport: PreviewViewport,
  baseTransform: Transform,
): Transform {
  const fitted = fittedSize(source, viewport);
  const scale = safeDisplayScale(viewport);

  const clipCanvasWidth = rect.width / scale;
  const clipCanvasHeight = rect.height / scale;

  const topLeftCanvas = screenToCanvas({ x: rect.left, y: rect.top }, viewport);

  const anchorCanvasX = topLeftCanvas.x + clipCanvasWidth * baseTransform.anchor.x;
  const anchorCanvasY = topLeftCanvas.y + clipCanvasHeight * baseTransform.anchor.y;

  const canvasWidth = Math.max(1, viewport.canvasWidth);
  const canvasHeight = Math.max(1, viewport.canvasHeight);

  return {
    position: {
      x: clamp01(anchorCanvasX / canvasWidth),
      y: clamp01(anchorCanvasY / canvasHeight),
    },
    scale: {
      x: Math.max(MIN_TRANSFORM_SCALE, clipCanvasWidth / fitted.width),
      y: Math.max(MIN_TRANSFORM_SCALE, clipCanvasHeight / fitted.height),
    },
    rotationDeg: Number.isFinite(rect.rotationDeg) ? rect.rotationDeg : 0,
    anchor: { x: baseTransform.anchor.x, y: baseTransform.anchor.y },
  };
}

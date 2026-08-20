/**
 * previewCoords Tests
 *
 * The coordinate module is the shared ground truth for every preview overlay,
 * so these tests pin the properties the overlays rely on:
 * - contain-fit matches the canvas renderer for landscape, portrait and text
 * - screen <-> canvas is an exact inverse pair, including pan
 * - transform <-> rectangle round-trips for identity, translated, scaled,
 *   rotated, non-uniform and non-center-anchor transforms
 * - rotation is anchored to the anchor point, not the box center
 */

import { describe, it, expect } from 'vitest';
import type { Transform } from '@/types';
import {
  PLAY_RES_Y,
  MIN_TRANSFORM_SCALE,
  clamp01,
  scaleFontSizeToCanvas,
  computeContainFit,
  resolveBaseScale,
  isViewportUsable,
  canvasToScreen,
  screenToCanvas,
  clipBoundsFromTransform,
  transformFromScreenRect,
  type PreviewViewport,
  type PreviewSource,
} from './previewCoords';

function makeViewport(overrides: Partial<PreviewViewport> = {}): PreviewViewport {
  return {
    canvasWidth: 1920,
    canvasHeight: 1080,
    containerWidth: 960,
    containerHeight: 540,
    displayScale: 0.5,
    panX: 0,
    panY: 0,
    ...overrides,
  };
}

function makeTransform(overrides: Partial<Transform> = {}): Transform {
  return {
    position: { x: 0.5, y: 0.5 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0.5, y: 0.5 },
    ...overrides,
  };
}

const landscapeSource: PreviewSource = { width: 1920, height: 1080 };
const portraitSource: PreviewSource = { width: 1080, height: 1920 };
const textSource: PreviewSource = { width: 320, height: 96, isCanvasSpace: true };

describe('previewCoords', () => {
  describe('clamp01', () => {
    it('should pass through values inside the range', () => {
      expect(clamp01(0)).toBe(0);
      expect(clamp01(0.42)).toBe(0.42);
      expect(clamp01(1)).toBe(1);
    });

    it('should clamp values outside the range', () => {
      expect(clamp01(-3)).toBe(0);
      expect(clamp01(9)).toBe(1);
    });

    it('should fall back to 0 for non-finite input', () => {
      expect(clamp01(Number.NaN)).toBe(0);
      expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
    });
  });

  describe('scaleFontSizeToCanvas', () => {
    it('should return the authored size when the canvas is the reference height', () => {
      expect(scaleFontSizeToCanvas(48, PLAY_RES_Y)).toBe(48);
    });

    it('should scale proportionally to canvas height', () => {
      expect(scaleFontSizeToCanvas(48, 540)).toBe(24);
      expect(scaleFontSizeToCanvas(48, 2160)).toBe(96);
    });

    it('should honour the minimum pixel floor', () => {
      expect(scaleFontSizeToCanvas(2, 100, 12)).toBe(12);
      expect(scaleFontSizeToCanvas(0, 1080, 1)).toBe(1);
    });

    it('should treat non-finite input as zero', () => {
      expect(scaleFontSizeToCanvas(Number.NaN, 1080)).toBe(0);
      expect(scaleFontSizeToCanvas(48, Number.NaN)).toBe(0);
    });
  });

  describe('computeContainFit', () => {
    it('should fit a landscape source by width when it is wider than the canvas', () => {
      // 2:1 source in a 16:9 canvas -> constrained by width.
      expect(computeContainFit(1920, 960, 1920, 1080)).toBeCloseTo(1);
      expect(computeContainFit(3840, 1920, 1920, 1080)).toBeCloseTo(0.5);
    });

    it('should fit a portrait source by height', () => {
      expect(computeContainFit(1080, 1920, 1920, 1080)).toBeCloseTo(1080 / 1920);
    });

    it('should match the exact-aspect case', () => {
      expect(computeContainFit(1920, 1080, 1920, 1080)).toBe(1);
      expect(computeContainFit(960, 540, 1920, 1080)).toBe(2);
    });

    it('should agree with the canvas renderer formula (min of both axis ratios)', () => {
      const cases: Array<[number, number, number, number]> = [
        [1920, 1080, 1280, 720],
        [1080, 1920, 1920, 1080],
        [640, 480, 1920, 1080],
        [4096, 1716, 1920, 1080],
      ];

      for (const [sw, sh, cw, ch] of cases) {
        expect(computeContainFit(sw, sh, cw, ch)).toBe(Math.min(cw / sw, ch / sh));
      }
    });

    it('should return 1 for degenerate inputs', () => {
      expect(computeContainFit(0, 1080, 1920, 1080)).toBe(1);
      expect(computeContainFit(1920, 1080, 0, 1080)).toBe(1);
      expect(computeContainFit(Number.NaN, 1080, 1920, 1080)).toBe(1);
    });
  });

  describe('resolveBaseScale', () => {
    it('should contain-fit non-text sources', () => {
      const viewport = makeViewport();
      expect(resolveBaseScale(portraitSource, viewport)).toBeCloseTo(1080 / 1920);
    });

    it('should skip the contain-fit for canvas-space (text) sources', () => {
      const viewport = makeViewport();
      expect(resolveBaseScale(textSource, viewport)).toBe(1);
    });
  });

  describe('isViewportUsable', () => {
    it('should accept a measured viewport', () => {
      expect(isViewportUsable(makeViewport())).toBe(true);
    });

    it('should reject a zero or non-finite display scale', () => {
      expect(isViewportUsable(makeViewport({ displayScale: 0 }))).toBe(false);
      expect(isViewportUsable(makeViewport({ displayScale: Number.NaN }))).toBe(false);
    });

    it('should reject a degenerate canvas', () => {
      expect(isViewportUsable(makeViewport({ canvasWidth: 0 }))).toBe(false);
      expect(isViewportUsable(makeViewport({ canvasHeight: -1 }))).toBe(false);
    });
  });

  describe('canvasToScreen / screenToCanvas', () => {
    it('should map the canvas center to the container center when unpanned', () => {
      const viewport = makeViewport();
      const screen = canvasToScreen({ x: 960, y: 540 }, viewport);
      expect(screen.x).toBeCloseTo(480);
      expect(screen.y).toBeCloseTo(270);
    });

    it('should apply pan as a screen-space offset', () => {
      const viewport = makeViewport({ panX: 37, panY: -11 });
      const screen = canvasToScreen({ x: 960, y: 540 }, viewport);
      expect(screen.x).toBeCloseTo(480 + 37);
      expect(screen.y).toBeCloseTo(270 - 11);
    });

    it('should be an exact inverse pair across zoom and pan', () => {
      const viewports = [
        makeViewport(),
        makeViewport({ displayScale: 1.75, panX: 120, panY: -64 }),
        makeViewport({ canvasWidth: 1080, canvasHeight: 1920, displayScale: 0.25, panX: -9 }),
      ];
      const points = [
        { x: 0, y: 0 },
        { x: 960, y: 540 },
        { x: 1919, y: 1079 },
        { x: -240, y: 3000 },
      ];

      for (const viewport of viewports) {
        for (const point of points) {
          const round = screenToCanvas(canvasToScreen(point, viewport), viewport);
          expect(round.x).toBeCloseTo(point.x, 8);
          expect(round.y).toBeCloseTo(point.y, 8);
        }
      }
    });

    it('should not silently drop pan when inverting', () => {
      const viewport = makeViewport({ panX: 200, panY: 100 });
      const unpanned = makeViewport();

      const withPan = screenToCanvas({ x: 480, y: 270 }, viewport);
      const withoutPan = screenToCanvas({ x: 480, y: 270 }, unpanned);

      expect(withPan.x).not.toBeCloseTo(withoutPan.x);
      expect(withPan.y).not.toBeCloseTo(withoutPan.y);
    });
  });

  describe('clipBoundsFromTransform', () => {
    it('should center an identity landscape clip on the container', () => {
      const viewport = makeViewport();
      const bounds = clipBoundsFromTransform(makeTransform(), landscapeSource, viewport);

      expect(bounds.left).toBeCloseTo(0);
      expect(bounds.top).toBeCloseTo(0);
      expect(bounds.width).toBeCloseTo(960);
      expect(bounds.height).toBeCloseTo(540);
      expect(bounds.centerX).toBeCloseTo(480);
      expect(bounds.centerY).toBeCloseTo(270);
    });

    it('should letterbox a portrait source inside a landscape canvas', () => {
      const viewport = makeViewport();
      const bounds = clipBoundsFromTransform(makeTransform(), portraitSource, viewport);

      // contain-fit -> 1080 tall, 607.5 wide in canvas px; half that on screen.
      expect(bounds.height).toBeCloseTo(540);
      expect(bounds.width).toBeCloseTo((1080 * (1080 / 1920)) / 2);
      expect(bounds.centerX).toBeCloseTo(480);
    });

    it('should place a left-anchored text clip so its anchor sits on the position', () => {
      const viewport = makeViewport();
      const transform = makeTransform({
        position: { x: 0.25, y: 0.5 },
        anchor: { x: 0, y: 0.5 },
      });
      const bounds = clipBoundsFromTransform(transform, textSource, viewport);

      // Anchor x = 0 -> the box left edge sits exactly on the position.
      expect(bounds.left).toBeCloseTo(bounds.anchorScreenX);
      expect(bounds.anchorScreenX).toBeCloseTo(canvasToScreen({ x: 480, y: 540 }, viewport).x);
      expect(bounds.width).toBeCloseTo(320 * 0.5);
      expect(bounds.height).toBeCloseTo(96 * 0.5);
    });

    it('should report the anchor as the rotation origin, not the box center', () => {
      const viewport = makeViewport();
      const transform = makeTransform({
        anchor: { x: 0, y: 0 },
        rotationDeg: 30,
      });
      const bounds = clipBoundsFromTransform(transform, landscapeSource, viewport);

      expect(bounds.rotationDeg).toBe(30);
      expect(bounds.anchorScreenX).toBeCloseTo(bounds.left);
      expect(bounds.anchorScreenY).toBeCloseTo(bounds.top);
      expect(bounds.anchorScreenX).not.toBeCloseTo(bounds.centerX);
    });

    it('should keep the anchor pinned to the position while the clip scales', () => {
      const viewport = makeViewport();
      const anchor = { x: 0.25, y: 0.75 };
      const small = clipBoundsFromTransform(
        makeTransform({ anchor, scale: { x: 0.5, y: 0.5 } }),
        landscapeSource,
        viewport,
      );
      const large = clipBoundsFromTransform(
        makeTransform({ anchor, scale: { x: 2, y: 2 } }),
        landscapeSource,
        viewport,
      );

      expect(small.anchorScreenX).toBeCloseTo(large.anchorScreenX);
      expect(small.anchorScreenY).toBeCloseTo(large.anchorScreenY);
    });
  });

  describe('transform <-> rectangle round-trip', () => {
    const cases: Array<{ name: string; transform: Transform; source: PreviewSource }> = [
      { name: 'identity', transform: makeTransform(), source: landscapeSource },
      {
        name: 'translated',
        transform: makeTransform({ position: { x: 0.2, y: 0.8 } }),
        source: landscapeSource,
      },
      {
        name: 'uniformly scaled',
        transform: makeTransform({ scale: { x: 1.75, y: 1.75 } }),
        source: landscapeSource,
      },
      {
        name: 'non-uniformly scaled',
        transform: makeTransform({ scale: { x: 0.4, y: 2.3 } }),
        source: landscapeSource,
      },
      {
        name: 'rotated',
        transform: makeTransform({ rotationDeg: 42.5 }),
        source: landscapeSource,
      },
      {
        name: 'non-center anchor',
        transform: makeTransform({
          position: { x: 0.3, y: 0.6 },
          anchor: { x: 0, y: 1 },
          scale: { x: 1.2, y: 0.9 },
          rotationDeg: -15,
        }),
        source: landscapeSource,
      },
      {
        name: 'portrait source',
        transform: makeTransform({ position: { x: 0.65, y: 0.35 }, scale: { x: 1.3, y: 1.3 } }),
        source: portraitSource,
      },
      {
        name: 'canvas-space text source',
        transform: makeTransform({
          position: { x: 0.25, y: 0.5 },
          anchor: { x: 0, y: 0.5 },
          scale: { x: 1.4, y: 1.4 },
        }),
        source: textSource,
      },
    ];

    const viewports = [
      makeViewport(),
      makeViewport({ displayScale: 1, containerWidth: 1920, containerHeight: 1080 }),
      makeViewport({ displayScale: 0.33, panX: 45, panY: -20 }),
    ];

    for (const { name, transform, source } of cases) {
      it(`should round-trip a ${name} transform through the screen rectangle`, () => {
        for (const viewport of viewports) {
          const bounds = clipBoundsFromTransform(transform, source, viewport);
          const recovered = transformFromScreenRect(bounds, source, viewport, transform);

          expect(recovered.position.x).toBeCloseTo(transform.position.x, 8);
          expect(recovered.position.y).toBeCloseTo(transform.position.y, 8);
          expect(recovered.scale.x).toBeCloseTo(transform.scale.x, 8);
          expect(recovered.scale.y).toBeCloseTo(transform.scale.y, 8);
          expect(recovered.rotationDeg).toBeCloseTo(transform.rotationDeg, 8);
          expect(recovered.anchor.x).toBe(transform.anchor.x);
          expect(recovered.anchor.y).toBe(transform.anchor.y);
        }
      });
    }
  });

  describe('transformFromScreenRect', () => {
    it('should move the anchor position when the box is dragged right', () => {
      const viewport = makeViewport();
      const transform = makeTransform();
      const bounds = clipBoundsFromTransform(transform, landscapeSource, viewport);

      const moved = transformFromScreenRect(
        { ...bounds, left: bounds.left + 96 },
        landscapeSource,
        viewport,
        transform,
      );

      // 96 screen px at displayScale 0.5 = 192 canvas px = 0.1 of a 1920 canvas.
      expect(moved.position.x).toBeCloseTo(0.6);
      expect(moved.position.y).toBeCloseTo(0.5);
    });

    it('should clamp the recovered position to 0..1', () => {
      const viewport = makeViewport();
      const transform = makeTransform();
      const bounds = clipBoundsFromTransform(transform, landscapeSource, viewport);

      const far = transformFromScreenRect(
        { ...bounds, left: bounds.left + 100000, top: bounds.top - 100000 },
        landscapeSource,
        viewport,
        transform,
      );

      expect(far.position.x).toBe(1);
      expect(far.position.y).toBe(0);
    });

    it('should floor the recovered scale at the minimum', () => {
      const viewport = makeViewport();
      const transform = makeTransform();
      const bounds = clipBoundsFromTransform(transform, landscapeSource, viewport);

      const tiny = transformFromScreenRect(
        { ...bounds, width: 0, height: 0 },
        landscapeSource,
        viewport,
        transform,
      );

      expect(tiny.scale.x).toBe(MIN_TRANSFORM_SCALE);
      expect(tiny.scale.y).toBe(MIN_TRANSFORM_SCALE);
    });

    it('should keep scale.y untouched for a width-only (edge) resize', () => {
      const viewport = makeViewport();
      const transform = makeTransform();
      const bounds = clipBoundsFromTransform(transform, landscapeSource, viewport);

      const resized = transformFromScreenRect(
        { ...bounds, width: bounds.width + 100 },
        landscapeSource,
        viewport,
        transform,
      );

      expect(resized.scale.x).toBeGreaterThan(1);
      expect(resized.scale.y).toBeCloseTo(1, 8);
    });

    it('should carry the anchor over from the base transform', () => {
      const viewport = makeViewport();
      const transform = makeTransform({ anchor: { x: 0, y: 0.5 } });
      const bounds = clipBoundsFromTransform(transform, textSource, viewport);

      const recovered = transformFromScreenRect(bounds, textSource, viewport, transform);

      expect(recovered.anchor).toEqual({ x: 0, y: 0.5 });
    });

    it('should keep a left-anchored text position fixed when the right edge grows', () => {
      const viewport = makeViewport();
      const transform = makeTransform({
        position: { x: 0.25, y: 0.5 },
        anchor: { x: 0, y: 0.5 },
      });
      const bounds = clipBoundsFromTransform(transform, textSource, viewport);

      // Growing to the right keeps `left` fixed, which is what moveable emits
      // for an east-direction resize.
      const resized = transformFromScreenRect(
        { ...bounds, width: bounds.width + 120 },
        textSource,
        viewport,
        transform,
      );

      expect(resized.position.x).toBeCloseTo(0.25, 8);
      expect(resized.position.y).toBeCloseTo(0.5, 8);
      expect(resized.scale.x).toBeGreaterThan(1);
    });

    it('should move a center-anchored position when the right edge grows', () => {
      const viewport = makeViewport();
      const transform = makeTransform();
      const bounds = clipBoundsFromTransform(transform, landscapeSource, viewport);

      const resized = transformFromScreenRect(
        { ...bounds, width: bounds.width + 100 },
        landscapeSource,
        viewport,
        transform,
      );

      // Center anchor: the opposite (left) edge stays pinned, so the anchor drifts right.
      expect(resized.position.x).toBeGreaterThan(0.5);
      expect(resized.position.y).toBeCloseTo(0.5, 8);
    });

    it('should treat a non-finite rotation as zero', () => {
      const viewport = makeViewport();
      const transform = makeTransform();
      const bounds = clipBoundsFromTransform(transform, landscapeSource, viewport);

      const recovered = transformFromScreenRect(
        { ...bounds, rotationDeg: Number.NaN },
        landscapeSource,
        viewport,
        transform,
      );

      expect(recovered.rotationDeg).toBe(0);
    });
  });
});

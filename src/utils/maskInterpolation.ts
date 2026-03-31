/**
 * Mask shape interpolation for animated mask paths.
 *
 * Provides client-side linear interpolation between mask shapes,
 * avoiding IPC round-trips during timeline scrubbing.
 */
import type { MaskShape, MaskKeyframe, Easing } from '../types';

function clonePoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: point.x, y: point.y };
}

export function cloneMaskShape(shape: MaskShape): MaskShape {
  switch (shape.type) {
    case 'rectangle':
      return { ...shape };
    case 'ellipse':
      return { ...shape };
    case 'polygon':
      return {
        type: 'polygon',
        points: shape.points.map(clonePoint),
      };
    case 'bezier':
      return {
        type: 'bezier',
        points: shape.points.map((point) => ({
          anchor: clonePoint(point.anchor),
          handleIn: point.handleIn ? clonePoint(point.handleIn) : point.handleIn,
          handleOut: point.handleOut ? clonePoint(point.handleOut) : point.handleOut,
        })),
        closed: shape.closed,
      };
    case 'gradient':
      return {
        type: 'gradient',
        start: clonePoint(shape.start),
        end: clonePoint(shape.end),
        gradientType: shape.gradientType,
      };
  }
}

/** Applies an easing function to a linear parameter t (0.0-1.0) */
export function applyEasing(t: number, easing: Easing): number {
  const ct = Math.max(0, Math.min(1, t));
  switch (easing) {
    case 'linear':
      return ct;
    case 'ease_in':
      return ct * ct;
    case 'ease_out':
      return 1 - (1 - ct) * (1 - ct);
    case 'ease_in_out':
      return ct < 0.5 ? 2 * ct * ct : 1 - Math.pow(-2 * ct + 2, 2) / 2;
    case 'step':
      return ct < 0.5 ? 0 : 1;
    case 'hold':
      return 0;
    case 'cubic_bezier':
      return 3 * ct * ct - 2 * ct * ct * ct;
    default:
      return ct;
  }
}

/** Linearly interpolates between two numbers */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolates between two mask shapes at parameter t (0.0-1.0).
 *
 * Only interpolates between shapes of the same type.
 * Falls back to discrete step for mismatched types.
 */
export function interpolateMaskShape(shapeA: MaskShape, shapeB: MaskShape, t: number): MaskShape {
  const ct = Math.max(0, Math.min(1, t));

  if (shapeA.type !== shapeB.type) {
    return ct < 0.5 ? cloneMaskShape(shapeA) : cloneMaskShape(shapeB);
  }

  switch (shapeA.type) {
    case 'rectangle': {
      const b = shapeB as typeof shapeA;
      return {
        type: 'rectangle',
        x: lerp(shapeA.x, b.x, ct),
        y: lerp(shapeA.y, b.y, ct),
        width: lerp(shapeA.width, b.width, ct),
        height: lerp(shapeA.height, b.height, ct),
        cornerRadius: lerp(shapeA.cornerRadius, b.cornerRadius, ct),
        rotation: lerp(shapeA.rotation, b.rotation, ct),
      };
    }
    case 'ellipse': {
      const b = shapeB as typeof shapeA;
      return {
        type: 'ellipse',
        x: lerp(shapeA.x, b.x, ct),
        y: lerp(shapeA.y, b.y, ct),
        radiusX: lerp(shapeA.radiusX, b.radiusX, ct),
        radiusY: lerp(shapeA.radiusY, b.radiusY, ct),
        rotation: lerp(shapeA.rotation, b.rotation, ct),
      };
    }
    case 'polygon': {
      const b = shapeB as typeof shapeA;
      if (shapeA.points.length !== b.points.length) {
        return ct < 0.5 ? cloneMaskShape(shapeA) : cloneMaskShape(b);
      }
      return {
        type: 'polygon',
        points: shapeA.points.map((pa, i) => ({
          x: lerp(pa.x, b.points[i].x, ct),
          y: lerp(pa.y, b.points[i].y, ct),
        })),
      };
    }
    case 'bezier': {
      const b = shapeB as typeof shapeA;
      if (shapeA.points.length !== b.points.length || shapeA.closed !== b.closed) {
        return ct < 0.5 ? cloneMaskShape(shapeA) : cloneMaskShape(b);
      }
      return {
        type: 'bezier',
        points: shapeA.points.map((bpA, i) => {
          const bpB = b.points[i];
          return {
            anchor: {
              x: lerp(bpA.anchor.x, bpB.anchor.x, ct),
              y: lerp(bpA.anchor.y, bpB.anchor.y, ct),
            },
            handleIn:
              bpA.handleIn && bpB.handleIn
                ? {
                    x: lerp(bpA.handleIn.x, bpB.handleIn.x, ct),
                    y: lerp(bpA.handleIn.y, bpB.handleIn.y, ct),
                  }
                : (bpA.handleIn ?? bpB.handleIn ?? null),
            handleOut:
              bpA.handleOut && bpB.handleOut
                ? {
                    x: lerp(bpA.handleOut.x, bpB.handleOut.x, ct),
                    y: lerp(bpA.handleOut.y, bpB.handleOut.y, ct),
                  }
                : (bpA.handleOut ?? bpB.handleOut ?? null),
          };
        }),
        closed: shapeA.closed,
      };
    }
    case 'gradient': {
      const b = shapeB as typeof shapeA;
      if (shapeA.gradientType !== b.gradientType) {
        return ct < 0.5 ? cloneMaskShape(shapeA) : cloneMaskShape(b);
      }
      return {
        type: 'gradient',
        start: { x: lerp(shapeA.start.x, b.start.x, ct), y: lerp(shapeA.start.y, b.start.y, ct) },
        end: { x: lerp(shapeA.end.x, b.end.x, ct), y: lerp(shapeA.end.y, b.end.y, ct) },
        gradientType: shapeA.gradientType,
      };
    }
    default:
      return ct < 0.5 ? cloneMaskShape(shapeA) : cloneMaskShape(shapeB);
  }
}

/**
 * Resolves the mask shape at a given time from keyframes.
 *
 * Mirrors the Rust Mask::shape_at_time logic for client-side preview.
 */
export function resolveShapeAtTime(
  baseShape: MaskShape,
  keyframes: MaskKeyframe[] | undefined,
  timeOffset: number,
): MaskShape {
  if (!keyframes || keyframes.length === 0) {
    return cloneMaskShape(baseShape);
  }

  // Before first keyframe
  if (timeOffset <= keyframes[0].timeOffset) {
    return cloneMaskShape(keyframes[0].shape);
  }

  // After last keyframe
  if (timeOffset >= keyframes[keyframes.length - 1].timeOffset) {
    return cloneMaskShape(keyframes[keyframes.length - 1].shape);
  }

  // Find surrounding keyframes and interpolate
  for (let i = 0; i < keyframes.length - 1; i++) {
    const kfA = keyframes[i];
    const kfB = keyframes[i + 1];
    if (timeOffset >= kfA.timeOffset && timeOffset <= kfB.timeOffset) {
      const duration = kfB.timeOffset - kfA.timeOffset;
      if (duration <= 0) return cloneMaskShape(kfA.shape);
      const rawT = (timeOffset - kfA.timeOffset) / duration;
      const t = applyEasing(rawT, kfA.easing);
      return interpolateMaskShape(kfA.shape, kfB.shape, t);
    }
  }

  return cloneMaskShape(baseShape);
}

import type { Clip, Transform, TransformKeyframe } from '@/types';

const DEFAULT_TRANSFORM: Transform = {
  position: { x: 0.5, y: 0.5 },
  scale: { x: 1, y: 1 },
  rotationDeg: 0,
  anchor: { x: 0.5, y: 0.5 },
};

function finiteOrFallback(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function normalizeTransform(transform: Transform | undefined): Transform {
  return {
    position: {
      x: finiteOrFallback(transform?.position.x, DEFAULT_TRANSFORM.position.x),
      y: finiteOrFallback(transform?.position.y, DEFAULT_TRANSFORM.position.y),
    },
    scale: {
      x: Math.max(0.01, finiteOrFallback(transform?.scale.x, DEFAULT_TRANSFORM.scale.x)),
      y: Math.max(0.01, finiteOrFallback(transform?.scale.y, DEFAULT_TRANSFORM.scale.y)),
    },
    rotationDeg: finiteOrFallback(transform?.rotationDeg, DEFAULT_TRANSFORM.rotationDeg),
    anchor: {
      x: finiteOrFallback(transform?.anchor.x, DEFAULT_TRANSFORM.anchor.x),
      y: finiteOrFallback(transform?.anchor.y, DEFAULT_TRANSFORM.anchor.y),
    },
  };
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

export function interpolateTransform(
  start: Transform,
  end: Transform,
  t: number,
): Transform {
  const easedT = Math.min(1, Math.max(0, t));

  return {
    position: {
      x: lerp(start.position.x, end.position.x, easedT),
      y: lerp(start.position.y, end.position.y, easedT),
    },
    scale: {
      x: lerp(start.scale.x, end.scale.x, easedT),
      y: lerp(start.scale.y, end.scale.y, easedT),
    },
    rotationDeg: lerp(start.rotationDeg, end.rotationDeg, easedT),
    anchor: {
      x: lerp(start.anchor.x, end.anchor.x, easedT),
      y: lerp(start.anchor.y, end.anchor.y, easedT),
    },
  };
}

function sortedValidKeyframes(keyframes: TransformKeyframe[] | undefined): TransformKeyframe[] {
  return (keyframes ?? [])
    .filter((keyframe) => Number.isFinite(keyframe.timeOffset) && keyframe.timeOffset >= 0)
    .map((keyframe) => ({
      ...keyframe,
      transform: normalizeTransform(keyframe.transform),
    }))
    .sort((a, b) => a.timeOffset - b.timeOffset);
}

export function getClipMotionTransformAtTime(clip: Clip, timelineTimeSec: number): Transform {
  const keyframes = sortedValidKeyframes(clip.motionKeyframes);
  if (keyframes.length === 0) {
    return normalizeTransform(clip.transform);
  }

  const clipTime = Math.max(0, timelineTimeSec - clip.place.timelineInSec);
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];

  if (clipTime <= first.timeOffset) {
    return normalizeTransform(first.transform);
  }

  if (clipTime >= last.timeOffset) {
    return normalizeTransform(last.transform);
  }

  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const current = keyframes[index];
    const next = keyframes[index + 1];
    if (clipTime < current.timeOffset || clipTime > next.timeOffset) {
      continue;
    }

    if (current.interpolation === 'hold') {
      return normalizeTransform(current.transform);
    }

    const duration = next.timeOffset - current.timeOffset;
    const t = duration > 0 ? (clipTime - current.timeOffset) / duration : 0;
    return interpolateTransform(current.transform, next.transform, t);
  }

  return normalizeTransform(clip.transform);
}


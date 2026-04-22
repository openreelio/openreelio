import { hasActiveTimeRemap, type Clip, type TimeRemapCurve } from '@/types';

const MIN_DURATION_EPSILON_SEC = 1e-6;
const BEZIER_SOLVER_ITERATIONS = 8;
const TIME_REMAP_INVERSION_ITERATIONS = 24;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

export function getSafeClipSpeed(clip: Clip): number {
  return clip.speed > 0 ? clip.speed : 1;
}

export function getClipRangeDurationSec(clip: Clip): number {
  const rangeDuration = clip.range.sourceOutSec - clip.range.sourceInSec;
  if (!Number.isFinite(rangeDuration)) {
    return 0;
  }

  return Math.max(0, rangeDuration);
}

export function getTimeRemapTimelineDurationSec(curve: TimeRemapCurve | null | undefined): number {
  if (!curve || curve.keyframes.length < 2) {
    return 0;
  }

  const firstTimelineTime = curve.keyframes[0]?.timelineTime;
  const lastTimelineTime = curve.keyframes[curve.keyframes.length - 1]?.timelineTime;
  if (!Number.isFinite(firstTimelineTime) || !Number.isFinite(lastTimelineTime)) {
    return 0;
  }

  return Math.max(0, lastTimelineTime - firstTimelineTime);
}

function cubicBezierT(cp1x: number, cp2x: number, targetX: number): number {
  let t = clamp(targetX, 0, 1);

  for (let iteration = 0; iteration < BEZIER_SOLVER_ITERATIONS; iteration += 1) {
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;

    const x = 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t3;
    const dx = 3 * mt2 * cp1x + 6 * mt * t * (cp2x - cp1x) + 3 * t2 * (1 - cp2x);

    if (Math.abs(dx) < 1e-12) {
      break;
    }

    t = clamp(t - (x - targetX) / dx, 0, 1);
  }

  return t;
}

function cubicBezierY(cp1y: number, cp2y: number, t: number): number {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t * t2;
}

export function evaluateTimeRemapCurve(
  curve: TimeRemapCurve | null | undefined,
  timelineOffsetSec: number,
): number {
  if (!curve || curve.keyframes.length === 0) {
    return Number.isFinite(timelineOffsetSec) ? timelineOffsetSec : 0;
  }

  const safeTimelineOffset = Number.isFinite(timelineOffsetSec) ? timelineOffsetSec : 0;
  const firstKeyframe = curve.keyframes[0];
  if (safeTimelineOffset <= firstKeyframe.timelineTime) {
    return firstKeyframe.sourceTime;
  }

  const lastKeyframe = curve.keyframes[curve.keyframes.length - 1];
  if (safeTimelineOffset >= lastKeyframe.timelineTime) {
    return lastKeyframe.sourceTime;
  }

  for (let index = 0; index < curve.keyframes.length - 1; index += 1) {
    const start = curve.keyframes[index];
    const end = curve.keyframes[index + 1];
    if (safeTimelineOffset < start.timelineTime || safeTimelineOffset >= end.timelineTime) {
      continue;
    }

    const segmentDuration = end.timelineTime - start.timelineTime;
    if (!Number.isFinite(segmentDuration) || segmentDuration <= 0) {
      return start.sourceTime;
    }

    const t = clamp((safeTimelineOffset - start.timelineTime) / segmentDuration, 0, 1);
    const interpolation = start.interpolation;
    if (interpolation === 'hold') {
      return start.sourceTime;
    }

    if (typeof interpolation === 'object' && interpolation && 'bezier' in interpolation) {
      const { cp1x, cp1y, cp2x, cp2y } = interpolation.bezier;
      const bezierT = cubicBezierT(cp1x, cp2x, t);
      const y = cubicBezierY(cp1y, cp2y, bezierT);
      return start.sourceTime + y * (end.sourceTime - start.sourceTime);
    }

    return start.sourceTime + t * (end.sourceTime - start.sourceTime);
  }

  return lastKeyframe.sourceTime;
}

function invertTimeRemapCurve(
  curve: TimeRemapCurve,
  sourceTimeSec: number,
  durationSec: number,
): number {
  if (curve.keyframes.length === 0) {
    return 0;
  }

  const safeSourceTime = Number.isFinite(sourceTimeSec)
    ? sourceTimeSec
    : curve.keyframes[0].sourceTime;
  const firstKeyframe = curve.keyframes[0];
  const lastKeyframe = curve.keyframes[curve.keyframes.length - 1];
  if (safeSourceTime <= firstKeyframe.sourceTime) {
    return 0;
  }
  if (safeSourceTime >= lastKeyframe.sourceTime) {
    return durationSec;
  }

  for (let index = 0; index < curve.keyframes.length - 1; index += 1) {
    const start = curve.keyframes[index];
    const end = curve.keyframes[index + 1];
    const segmentMin = Math.min(start.sourceTime, end.sourceTime);
    const segmentMax = Math.max(start.sourceTime, end.sourceTime);
    if (safeSourceTime < segmentMin || safeSourceTime > segmentMax) {
      continue;
    }

    if (start.interpolation === 'hold') {
      return clamp(start.timelineTime, 0, durationSec);
    }

    let low = clamp(start.timelineTime, 0, durationSec);
    let high = clamp(end.timelineTime, 0, durationSec);
    const ascending = end.sourceTime >= start.sourceTime;

    for (let iteration = 0; iteration < TIME_REMAP_INVERSION_ITERATIONS; iteration += 1) {
      const mid = (low + high) / 2;
      const midSourceTime = evaluateTimeRemapCurve(curve, mid);

      if (Math.abs(midSourceTime - safeSourceTime) <= MIN_DURATION_EPSILON_SEC) {
        return mid;
      }

      if (
        (ascending && midSourceTime < safeSourceTime) ||
        (!ascending && midSourceTime > safeSourceTime)
      ) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return (low + high) / 2;
  }

  return clamp(durationSec, 0, durationSec);
}

export function getClipTimelineDurationSec(clip: Clip): number {
  const placeDuration = clip.place.durationSec;
  if (Number.isFinite(placeDuration) && placeDuration > 0) {
    return placeDuration;
  }

  if (hasActiveTimeRemap(clip)) {
    const remapDuration = getTimeRemapTimelineDurationSec(clip.timeRemap);
    if (Number.isFinite(remapDuration) && remapDuration > 0) {
      return remapDuration;
    }
  }

  const safeSpeed = getSafeClipSpeed(clip);
  const rangeDerivedDuration = getClipRangeDurationSec(clip) / safeSpeed;
  if (Number.isFinite(rangeDerivedDuration) && rangeDerivedDuration > 0) {
    return rangeDerivedDuration;
  }

  return 0;
}

export function getClipTimelineEndSec(clip: Clip): number {
  return clip.place.timelineInSec + getClipTimelineDurationSec(clip);
}

export function isClipActiveAtTime(clip: Clip, timelineTimeSec: number, epsilonSec = 0): boolean {
  if (!Number.isFinite(timelineTimeSec)) {
    return false;
  }

  if (clip.enabled === false) {
    return false;
  }

  const clipStart = clip.place.timelineInSec - epsilonSec;
  const clipEnd = getClipTimelineEndSec(clip) + epsilonSec;
  if (clipEnd - clipStart <= MIN_DURATION_EPSILON_SEC) {
    return false;
  }

  return timelineTimeSec >= clipStart && timelineTimeSec < clipEnd;
}

export function getClipSourceTimeAtTimelineTime(clip: Clip, timelineTimeSec: number): number {
  const durationSec = getClipTimelineDurationSec(clip);
  const offsetInTimeline = clamp(timelineTimeSec - clip.place.timelineInSec, 0, durationSec);

  if (clip.freezeFrame) {
    return clip.range.sourceInSec;
  }

  if (hasActiveTimeRemap(clip)) {
    return evaluateTimeRemapCurve(clip.timeRemap, offsetInTimeline);
  }

  const safeSpeed = getSafeClipSpeed(clip);
  const sourceTime = clip.reverse
    ? clip.range.sourceOutSec - offsetInTimeline * safeSpeed
    : clip.range.sourceInSec + offsetInTimeline * safeSpeed;

  return Math.max(clip.range.sourceInSec, Math.min(sourceTime, clip.range.sourceOutSec));
}

export function getClipTimelineTimeAtSourceTime(clip: Clip, sourceTimeSec: number): number {
  if (clip.freezeFrame) {
    return clip.place.timelineInSec;
  }

  const durationSec = getClipTimelineDurationSec(clip);
  if (durationSec <= 0) {
    return clip.place.timelineInSec;
  }

  if (hasActiveTimeRemap(clip) && clip.timeRemap) {
    const timelineOffset = invertTimeRemapCurve(clip.timeRemap, sourceTimeSec, durationSec);
    return clip.place.timelineInSec + clamp(timelineOffset, 0, durationSec);
  }

  const clampedSourceTime = clamp(sourceTimeSec, clip.range.sourceInSec, clip.range.sourceOutSec);
  const safeSpeed = getSafeClipSpeed(clip);
  const offsetInSource = clip.reverse
    ? clip.range.sourceOutSec - clampedSourceTime
    : clampedSourceTime - clip.range.sourceInSec;

  return clip.place.timelineInSec + clamp(offsetInSource / safeSpeed, 0, durationSec);
}

export interface ClipTrimChange {
  clipId: string;
  timelineIn?: number;
  sourceIn?: number;
  sourceOut?: number;
}

export function supportsSourceBoundaryTrimming(clip: Clip): boolean {
  return !clip.freezeFrame && !hasActiveTimeRemap(clip);
}

export function getClipLeftTrimDeltaBoundsSec(
  clip: Clip,
  sourceDurationSec: number,
  minDurationSec: number,
): { minDeltaSec: number; maxDeltaSec: number } {
  const durationSec = getClipTimelineDurationSec(clip);
  const maxDeltaSec = Math.max(0, durationSec - Math.max(0, minDurationSec));

  if (!supportsSourceBoundaryTrimming(clip)) {
    return { minDeltaSec: 0, maxDeltaSec: 0 };
  }

  const safeSpeed = getSafeClipSpeed(clip);
  const availableExtensionSec = clip.reverse
    ? Math.max(0, sourceDurationSec - clip.range.sourceOutSec)
    : Math.max(0, clip.range.sourceInSec);

  return {
    minDeltaSec: -(availableExtensionSec / safeSpeed),
    maxDeltaSec,
  };
}

export function getClipRightTrimDeltaBoundsSec(
  clip: Clip,
  sourceDurationSec: number,
  minDurationSec: number,
): { minDeltaSec: number; maxDeltaSec: number } {
  const durationSec = getClipTimelineDurationSec(clip);
  const minDeltaSec = -Math.max(0, durationSec - Math.max(0, minDurationSec));

  if (!supportsSourceBoundaryTrimming(clip)) {
    return { minDeltaSec: 0, maxDeltaSec: 0 };
  }

  const safeSpeed = getSafeClipSpeed(clip);
  const availableExtensionSec = clip.reverse
    ? Math.max(0, clip.range.sourceInSec)
    : Math.max(0, sourceDurationSec - clip.range.sourceOutSec);

  return {
    minDeltaSec,
    maxDeltaSec: availableExtensionSec / safeSpeed,
  };
}

export function buildLeftTrimChange(clip: Clip, newTimelineInSec: number): ClipTrimChange | null {
  if (!Number.isFinite(newTimelineInSec) || !supportsSourceBoundaryTrimming(clip)) {
    return null;
  }

  const safeSpeed = getSafeClipSpeed(clip);
  const deltaSec = newTimelineInSec - clip.place.timelineInSec;

  if (clip.reverse) {
    return {
      clipId: clip.id,
      timelineIn: newTimelineInSec,
      sourceOut: clip.range.sourceOutSec - deltaSec * safeSpeed,
    };
  }

  return {
    clipId: clip.id,
    timelineIn: newTimelineInSec,
    sourceIn: clip.range.sourceInSec + deltaSec * safeSpeed,
  };
}

export function buildRightTrimChange(clip: Clip, newTimelineOutSec: number): ClipTrimChange | null {
  if (!Number.isFinite(newTimelineOutSec) || !supportsSourceBoundaryTrimming(clip)) {
    return null;
  }

  const safeSpeed = getSafeClipSpeed(clip);
  const deltaSec = newTimelineOutSec - getClipTimelineEndSec(clip);

  if (clip.reverse) {
    return {
      clipId: clip.id,
      sourceIn: clip.range.sourceInSec - deltaSec * safeSpeed,
    };
  }

  return {
    clipId: clip.id,
    sourceOut: clip.range.sourceOutSec + deltaSec * safeSpeed,
  };
}

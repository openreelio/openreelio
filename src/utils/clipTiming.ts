import type { Clip } from '@/types';

const MIN_DURATION_EPSILON_SEC = 1e-6;

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

export function getClipTimelineDurationSec(clip: Clip): number {
  const safeSpeed = getSafeClipSpeed(clip);
  const rangeDerivedDuration = getClipRangeDurationSec(clip) / safeSpeed;
  if (Number.isFinite(rangeDerivedDuration) && rangeDerivedDuration > 0) {
    return rangeDerivedDuration;
  }

  const placeDuration = clip.place.durationSec;
  if (Number.isFinite(placeDuration) && placeDuration > 0) {
    return placeDuration;
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

  const clipStart = clip.place.timelineInSec - epsilonSec;
  const clipEnd = getClipTimelineEndSec(clip) + epsilonSec;
  if (clipEnd - clipStart <= MIN_DURATION_EPSILON_SEC) {
    return false;
  }

  return timelineTimeSec >= clipStart && timelineTimeSec < clipEnd;
}

export function getClipSourceTimeAtTimelineTime(clip: Clip, timelineTimeSec: number): number {
  const offsetInTimeline = timelineTimeSec - clip.place.timelineInSec;
  const safeSpeed = getSafeClipSpeed(clip);
  const sourceTime = clip.range.sourceInSec + offsetInTimeline * safeSpeed;

  return Math.max(clip.range.sourceInSec, Math.min(sourceTime, clip.range.sourceOutSec));
}

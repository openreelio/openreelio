import type { Clip } from '@/types';

export const CLIP_AUDIO_MIN_VOLUME_DB = -60;
export const CLIP_AUDIO_MAX_VOLUME_DB = 6;
export const CLIP_AUDIO_MIN_PAN = -1;
export const CLIP_AUDIO_MAX_PAN = 1;

const FLOAT_EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function getClipTimelineDurationSec(clip: Clip): number {
  const safeSpeed = clip.speed > 0 ? clip.speed : 1;
  const rawDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;

  if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
    return 0;
  }

  return rawDuration;
}

export function clampClipVolumeDb(volumeDb: number): number {
  return clamp(volumeDb, CLIP_AUDIO_MIN_VOLUME_DB, CLIP_AUDIO_MAX_VOLUME_DB);
}

export function clampClipPan(pan: number): number {
  return clamp(pan, CLIP_AUDIO_MIN_PAN, CLIP_AUDIO_MAX_PAN);
}

export function normalizeClipFadeDurations(
  fadeInSec: number,
  fadeOutSec: number,
  clipDurationSec: number,
): { fadeInSec: number; fadeOutSec: number } {
  const safeDuration = Number.isFinite(clipDurationSec) ? Math.max(0, clipDurationSec) : 0;
  if (safeDuration <= FLOAT_EPSILON) {
    return { fadeInSec: 0, fadeOutSec: 0 };
  }

  let normalizedFadeIn = clamp(fadeInSec, 0, safeDuration);
  let normalizedFadeOut = clamp(fadeOutSec, 0, safeDuration);

  if (normalizedFadeIn + normalizedFadeOut > safeDuration) {
    const overflow = normalizedFadeIn + normalizedFadeOut - safeDuration;

    if (normalizedFadeIn >= normalizedFadeOut) {
      normalizedFadeIn = Math.max(0, normalizedFadeIn - overflow);
    } else {
      normalizedFadeOut = Math.max(0, normalizedFadeOut - overflow);
    }
  }

  return {
    fadeInSec: normalizedFadeIn,
    fadeOutSec: normalizedFadeOut,
  };
}

export function getClipFadeFactor(clip: Clip, clipOffsetSec: number): number {
  const durationSec = getClipTimelineDurationSec(clip);
  if (durationSec <= FLOAT_EPSILON) {
    return 1;
  }

  const { fadeInSec, fadeOutSec } = normalizeClipFadeDurations(
    clip.audio?.fadeInSec ?? 0,
    clip.audio?.fadeOutSec ?? 0,
    durationSec,
  );

  const clampedOffset = clamp(clipOffsetSec, 0, durationSec);

  let fadeInFactor = 1;
  if (fadeInSec > FLOAT_EPSILON) {
    fadeInFactor = clamp(clampedOffset / fadeInSec, 0, 1);
  }

  let fadeOutFactor = 1;
  if (fadeOutSec > FLOAT_EPSILON) {
    const remainingSec = durationSec - clampedOffset;
    fadeOutFactor = clamp(remainingSec / fadeOutSec, 0, 1);
  }

  return Math.min(fadeInFactor, fadeOutFactor);
}

import type { Clip, Sequence, Track, TrackKind } from '@/types';
import type { ClipTrimData } from '@/components/timeline/types';

const LINK_KEY_PRECISION = 6;

export interface ClipReference {
  clip: Clip;
  track: Track;
  trackIndex: number;
}

interface LinkedMoveTarget {
  clipId: string;
  trackId: string;
  newTimelineIn: number;
}

interface LinkedSplitTarget {
  clipId: string;
  trackId: string;
}

function normalizeLinkKeyValue(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return value.toFixed(LINK_KEY_PRECISION);
}

function getSafeSpeed(clip: Clip): number {
  return clip.speed > 0 ? clip.speed : 1;
}

function createClipLinkKey(clip: Clip): string {
  return [
    clip.assetId,
    normalizeLinkKeyValue(clip.place.timelineInSec),
    normalizeLinkKeyValue(clip.range.sourceInSec),
    normalizeLinkKeyValue(clip.range.sourceOutSec),
    normalizeLinkKeyValue(getSafeSpeed(clip)),
  ].join('|');
}

function trackKindCanHaveCompanion(trackKind: TrackKind): boolean {
  return trackKind === 'video' || trackKind === 'overlay' || trackKind === 'audio';
}

function isVisualTrackKind(trackKind: TrackKind): boolean {
  return trackKind === 'video' || trackKind === 'overlay';
}

function clipContainsTime(clip: Clip, time: number): boolean {
  const safeSpeed = getSafeSpeed(clip);
  const duration = (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
  const clipStart = clip.place.timelineInSec;
  const clipEnd = clipStart + duration;

  return time > clipStart && time < clipEnd;
}

export function findClipReference(sequence: Sequence, clipId: string): ClipReference | null {
  for (let trackIndex = 0; trackIndex < sequence.tracks.length; trackIndex += 1) {
    const track = sequence.tracks[trackIndex];
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) {
      return {
        clip,
        track,
        trackIndex,
      };
    }
  }

  return null;
}

export function findLinkedCompanionClipIds(sequence: Sequence, clipId: string): string[] {
  const sourceRef = findClipReference(sequence, clipId);
  if (!sourceRef) {
    return [];
  }

  if (!trackKindCanHaveCompanion(sourceRef.track.kind)) {
    return [];
  }

  const sourceIsAudio = sourceRef.track.kind === 'audio';
  const sourceKey = createClipLinkKey(sourceRef.clip);
  const companions: string[] = [];

  for (const track of sequence.tracks) {
    if (sourceIsAudio && !isVisualTrackKind(track.kind)) {
      continue;
    }

    if (!sourceIsAudio && track.kind !== 'audio') {
      continue;
    }

    for (const clip of track.clips) {
      if (clip.id === sourceRef.clip.id) {
        continue;
      }

      if (createClipLinkKey(clip) === sourceKey) {
        companions.push(clip.id);
      }
    }
  }

  return companions;
}

export function expandClipIdsWithLinkedCompanions(sequence: Sequence, clipIds: string[]): string[] {
  const resolved = new Set<string>();
  const queue: string[] = [];

  for (const clipId of clipIds) {
    if (!resolved.has(clipId)) {
      resolved.add(clipId);
      queue.push(clipId);
    }
  }

  while (queue.length > 0) {
    const currentClipId = queue.shift();
    if (!currentClipId) {
      continue;
    }

    const companionIds = findLinkedCompanionClipIds(sequence, currentClipId);
    for (const companionId of companionIds) {
      if (!resolved.has(companionId)) {
        resolved.add(companionId);
        queue.push(companionId);
      }
    }
  }

  return Array.from(resolved);
}

export function buildLinkedMoveTargets(
  sequence: Sequence,
  clipId: string,
  newTimelineIn: number,
): LinkedMoveTarget[] {
  const sourceRef = findClipReference(sequence, clipId);
  if (!sourceRef) {
    return [];
  }

  const moveDelta = newTimelineIn - sourceRef.clip.place.timelineInSec;
  const companionIds = findLinkedCompanionClipIds(sequence, clipId);

  const targets: LinkedMoveTarget[] = [];
  for (const companionId of companionIds) {
    const companionRef = findClipReference(sequence, companionId);
    if (!companionRef) {
      continue;
    }

    targets.push({
      clipId: companionRef.clip.id,
      trackId: companionRef.track.id,
      newTimelineIn: companionRef.clip.place.timelineInSec + moveDelta,
    });
  }

  return targets;
}

export function buildLinkedTrimTargets(sequence: Sequence, trimData: ClipTrimData): ClipTrimData[] {
  const sourceRef = findClipReference(sequence, trimData.clipId);
  if (!sourceRef) {
    return [];
  }

  const companionIds = findLinkedCompanionClipIds(sequence, trimData.clipId);
  if (companionIds.length === 0) {
    return [];
  }

  const sourceClip = sourceRef.clip;

  const sourceInDelta =
    typeof trimData.newSourceIn === 'number'
      ? trimData.newSourceIn - sourceClip.range.sourceInSec
      : undefined;
  const sourceOutDelta =
    typeof trimData.newSourceOut === 'number'
      ? trimData.newSourceOut - sourceClip.range.sourceOutSec
      : undefined;
  const timelineInDelta =
    typeof trimData.newTimelineIn === 'number'
      ? trimData.newTimelineIn - sourceClip.place.timelineInSec
      : undefined;

  const targets: ClipTrimData[] = [];
  for (const companionId of companionIds) {
    const companionRef = findClipReference(sequence, companionId);
    if (!companionRef) {
      continue;
    }

    const companionTrim: ClipTrimData = {
      sequenceId: trimData.sequenceId,
      trackId: companionRef.track.id,
      clipId: companionRef.clip.id,
    };

    if (typeof sourceInDelta === 'number') {
      companionTrim.newSourceIn = companionRef.clip.range.sourceInSec + sourceInDelta;
    }

    if (typeof sourceOutDelta === 'number') {
      companionTrim.newSourceOut = companionRef.clip.range.sourceOutSec + sourceOutDelta;
    }

    if (typeof timelineInDelta === 'number') {
      companionTrim.newTimelineIn = companionRef.clip.place.timelineInSec + timelineInDelta;
    }

    targets.push(companionTrim);
  }

  return targets;
}

export function getLinkedSplitTargets(
  sequence: Sequence,
  clipId: string,
  splitTime: number,
): LinkedSplitTarget[] {
  const companionIds = findLinkedCompanionClipIds(sequence, clipId);
  const targets: LinkedSplitTarget[] = [];

  for (const companionId of companionIds) {
    const companionRef = findClipReference(sequence, companionId);
    if (!companionRef) {
      continue;
    }

    if (!clipContainsTime(companionRef.clip, splitTime)) {
      continue;
    }

    targets.push({
      clipId: companionRef.clip.id,
      trackId: companionRef.track.id,
    });
  }

  return targets;
}

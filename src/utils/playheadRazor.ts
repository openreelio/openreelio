import { RAZOR_EDGE_THRESHOLD_SEC } from '@/constants/editing';
import type { Clip, Sequence } from '@/types';

export interface PlayheadRazorSplitTarget {
  trackId: string;
  clipId: string;
  splitTime: number;
}

function getClipEndTime(clip: Clip): number {
  const safeSpeed = clip.speed > 0 ? clip.speed : 1;
  return clip.place.timelineInSec + (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
}

export function getPlayheadRazorSplitTarget(
  sequence: Sequence,
  trackIndex: number,
  splitTime: number,
): PlayheadRazorSplitTarget | null {
  if (!Number.isFinite(splitTime) || trackIndex < 0 || trackIndex >= sequence.tracks.length) {
    return null;
  }

  const track = sequence.tracks[trackIndex];
  const clip = track.clips.find((candidate) => {
    const clipStart = candidate.place.timelineInSec;
    const clipEnd = getClipEndTime(candidate);

    return (
      splitTime > clipStart + RAZOR_EDGE_THRESHOLD_SEC &&
      splitTime < clipEnd - RAZOR_EDGE_THRESHOLD_SEC
    );
  });

  if (!clip) {
    return null;
  }

  return {
    trackId: track.id,
    clipId: clip.id,
    splitTime,
  };
}

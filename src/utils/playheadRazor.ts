import { RAZOR_EDGE_THRESHOLD_SEC } from '@/constants/editing';
import type { Clip, Sequence } from '@/types';
import { getClipTimelineEndSec } from '@/utils/clipTiming';

export interface PlayheadRazorSplitTarget {
  trackId: string;
  clipId: string;
  splitTime: number;
}

function getClipEndTime(clip: Clip): number {
  return getClipTimelineEndSec(clip);
}

export function getPlayheadRazorSplitTarget(
  sequence: Sequence,
  trackIndex: number,
  splitTime: number,
): PlayheadRazorSplitTarget | null {
  if (
    !Number.isFinite(splitTime) ||
    !Number.isInteger(trackIndex) ||
    trackIndex < 0 ||
    trackIndex >= sequence.tracks.length
  ) {
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

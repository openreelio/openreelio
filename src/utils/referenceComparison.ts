import type { ContentSegment, SegmentType } from '@/bindings';

export interface ComparisonTrackLike {
  id: string;
  kind: string;
  visible?: boolean;
  isBaseTrack?: boolean;
}

export interface ComparisonClipLike {
  trackId: string;
  timelineInSec: number;
  durationSec: number;
}

export interface ComparisonCurvePoint {
  time: number;
  value: number;
}

export interface OutputStructureSegment {
  startSec: number;
  endSec: number;
  segmentType: SegmentType | 'output';
}

function isVisible(track: ComparisonTrackLike): boolean {
  return track.visible !== false;
}

function isFiniteDuration(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function pickPrimaryVideoTrackId(tracks: ComparisonTrackLike[]): string | null {
  const videoTracks = tracks.filter((track) => track.kind === 'video');
  if (videoTracks.length === 0) {
    return null;
  }

  const preferences: Array<(track: ComparisonTrackLike) => boolean> = [
    (track) => track.isBaseTrack === true && isVisible(track),
    (track) => isVisible(track),
    (track) => track.isBaseTrack === true,
    () => true,
  ];

  for (const preference of preferences) {
    const match = videoTracks.find(preference);
    if (match) {
      return match.id;
    }
  }

  return null;
}

export function getPrimaryTrackClips(
  tracks: ComparisonTrackLike[],
  clips: ComparisonClipLike[],
): ComparisonClipLike[] {
  const primaryTrackId = pickPrimaryVideoTrackId(tracks);
  if (!primaryTrackId) {
    return [];
  }

  return clips
    .filter((clip) => clip.trackId === primaryTrackId && isFiniteDuration(clip.durationSec))
    .sort((left, right) => left.timelineInSec - right.timelineInSec);
}

export function getTimelineExtent(clips: ComparisonClipLike[]): number {
  return clips.reduce((maxEnd, clip) => {
    const clipEnd = clip.timelineInSec + clip.durationSec;
    return clipEnd > maxEnd ? clipEnd : maxEnd;
  }, 0);
}

export function derivePacingCurve(clips: ComparisonClipLike[]): ComparisonCurvePoint[] {
  const sortedClips = [...clips].sort((left, right) => left.timelineInSec - right.timelineInSec);
  const totalDuration = getTimelineExtent(sortedClips);
  if (sortedClips.length === 0 || totalDuration <= 0) {
    return [];
  }

  return sortedClips.map((clip) => ({
    time: (clip.timelineInSec + clip.durationSec / 2) / totalDuration,
    value: clip.durationSec,
  }));
}

export function calculatePearsonCorrelation(reference: number[], output: number[]): number {
  const sampleSize = Math.min(reference.length, output.length);
  if (sampleSize < 2) {
    return 0;
  }

  let referenceSum = 0;
  let outputSum = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    referenceSum += reference[index];
    outputSum += output[index];
  }

  const referenceMean = referenceSum / sampleSize;
  const outputMean = outputSum / sampleSize;

  let numerator = 0;
  let referenceVariance = 0;
  let outputVariance = 0;

  for (let index = 0; index < sampleSize; index += 1) {
    const referenceDelta = reference[index] - referenceMean;
    const outputDelta = output[index] - outputMean;
    numerator += referenceDelta * outputDelta;
    referenceVariance += referenceDelta * referenceDelta;
    outputVariance += outputDelta * outputDelta;
  }

  const denominator = Math.sqrt(referenceVariance * outputVariance);
  if (denominator === 0) {
    return 0;
  }

  const correlation = numerator / denominator;
  return Math.max(-1, Math.min(1, correlation));
}

function findSegmentTypeAtPosition(
  referenceSegments: ContentSegment[],
  normalizedPosition: number,
): SegmentType | 'output' {
  if (referenceSegments.length === 0) {
    return 'output';
  }

  const referenceDuration = Math.max(...referenceSegments.map((segment) => segment.endSec), 0);
  if (referenceDuration <= 0) {
    return 'output';
  }

  const containingSegment = referenceSegments.find((segment) => {
    const normalizedStart = segment.startSec / referenceDuration;
    const normalizedEnd = segment.endSec / referenceDuration;
    return normalizedPosition >= normalizedStart && normalizedPosition <= normalizedEnd;
  });
  if (containingSegment) {
    return containingSegment.segmentType;
  }

  const nearestSegment = referenceSegments.reduce<ContentSegment | null>((nearest, candidate) => {
    const nearestMidpoint = nearest
      ? (nearest.startSec + nearest.endSec) / (2 * referenceDuration)
      : Number.POSITIVE_INFINITY;
    const candidateMidpoint = (candidate.startSec + candidate.endSec) / (2 * referenceDuration);

    return Math.abs(candidateMidpoint - normalizedPosition) <
      Math.abs(nearestMidpoint - normalizedPosition)
      ? candidate
      : nearest;
  }, null);

  return nearestSegment?.segmentType ?? 'output';
}

export function buildOutputStructureSegments(
  referenceSegments: ContentSegment[],
  outputClips: ComparisonClipLike[],
): OutputStructureSegment[] {
  const totalDuration = getTimelineExtent(outputClips);
  if (outputClips.length === 0 || totalDuration <= 0) {
    return [];
  }

  return outputClips.map((clip) => ({
    startSec: clip.timelineInSec,
    endSec: clip.timelineInSec + clip.durationSec,
    segmentType: findSegmentTypeAtPosition(
      referenceSegments,
      (clip.timelineInSec + clip.durationSec / 2) / totalDuration,
    ),
  }));
}

export function buildTransitionDiffCounts(
  referenceFrequency: Record<string, number>,
  outputTransitionCount: number,
): Array<{ type: string; referenceCount: number; outputCount: number }> {
  const transitionTypes = new Set(Object.keys(referenceFrequency));
  if (outputTransitionCount > 0) {
    transitionTypes.add('cut');
  }

  const rows = Array.from(transitionTypes).map((type) => ({
    type,
    referenceCount: referenceFrequency[type] ?? 0,
    outputCount: type === 'cut' ? outputTransitionCount : 0,
  }));

  rows.sort((left, right) => {
    const leftMagnitude = Math.max(left.referenceCount, left.outputCount);
    const rightMagnitude = Math.max(right.referenceCount, right.outputCount);
    return rightMagnitude - leftMagnitude || left.type.localeCompare(right.type);
  });

  return rows;
}

import { probeMedia } from '@/utils/ffmpeg';
import { findClipReference } from '@/utils/clipLinking';
import type { ClipAudioUpdateData, TrackCreateData } from '@/components/timeline/Timeline';
import type { Asset, Clip, Sequence, Track } from '@/types';

export const DEFAULT_INSERT_CLIP_DURATION_SEC = 10;

const TIMELINE_TIME_EPSILON_SEC = 1e-6;

const TRACK_KIND_LABEL: Record<TrackCreateData['kind'], string> = {
  video: 'Video',
  audio: 'Audio',
};

interface WarnLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

export function getClipTimelineDuration(clip: Clip): number {
  const safeSpeed = clip.speed > 0 ? clip.speed : 1;
  return (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && endA > startB;
}

export function trackHasOverlap(
  track: Track,
  timelineIn: number,
  durationSec: number,
  ignoreClipId?: string,
): boolean {
  const candidateEnd = timelineIn + durationSec;

  return track.clips.some((clip) => {
    if (ignoreClipId && clip.id === ignoreClipId) {
      return false;
    }

    const clipStart = clip.place.timelineInSec;
    const clipEnd = clipStart + getClipTimelineDuration(clip);
    return rangesOverlap(timelineIn, candidateEnd, clipStart, clipEnd);
  });
}

export function getAssetInsertDurationSec(asset: Asset): number {
  if (
    typeof asset.durationSec === 'number' &&
    Number.isFinite(asset.durationSec) &&
    asset.durationSec > 0
  ) {
    return asset.durationSec;
  }

  return DEFAULT_INSERT_CLIP_DURATION_SEC;
}

export async function resolveAssetHasLinkedAudio(
  asset: Asset,
  logger: WarnLogger,
): Promise<boolean> {
  if (asset.kind !== 'video') {
    return false;
  }

  if (asset.audio) {
    return true;
  }

  try {
    const mediaInfo = await probeMedia(asset.uri);
    return Boolean(mediaInfo.audio);
  } catch (error) {
    logger.warn('Unable to probe dropped video for audio stream detection', {
      assetId: asset.id,
      uri: asset.uri,
      error,
    });
    return false;
  }
}

export function findClipByAssetAtTimeline(
  track: Track | undefined,
  assetId: string,
  timelineInSec: number,
): Clip | undefined {
  if (!track) {
    return undefined;
  }

  return track.clips.find(
    (clip) =>
      clip.assetId === assetId &&
      Math.abs(clip.place.timelineInSec - timelineInSec) <= TIMELINE_TIME_EPSILON_SEC,
  );
}

function findAvailableAudioTrack(
  sequence: Sequence,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  return sequence.tracks.find((track) => {
    if (track.kind !== 'audio' || track.locked) {
      return false;
    }

    return !trackHasOverlap(track, timelineIn, durationSec);
  });
}

function isVisualTrackKind(trackKind: Track['kind']): boolean {
  return trackKind === 'video' || trackKind === 'overlay';
}

function canInsertClipOnTrack(track: Track, timelineIn: number, durationSec: number): boolean {
  return !track.locked && !trackHasOverlap(track, timelineIn, durationSec);
}

function findAvailableVisualTrack(
  sequence: Sequence,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  return sequence.tracks.find(
    (track) =>
      isVisualTrackKind(track.kind) && canInsertClipOnTrack(track, timelineIn, durationSec),
  );
}

export function selectPreferredVisualTrack(
  sequence: Sequence,
  targetTrack: Track | undefined,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  if (
    targetTrack &&
    isVisualTrackKind(targetTrack.kind) &&
    canInsertClipOnTrack(targetTrack, timelineIn, durationSec)
  ) {
    return targetTrack;
  }

  return findAvailableVisualTrack(sequence, timelineIn, durationSec);
}

export function selectPreferredAudioTrack(
  sequence: Sequence,
  targetTrack: Track | undefined,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  if (
    targetTrack &&
    targetTrack.kind === 'audio' &&
    canInsertClipOnTrack(targetTrack, timelineIn, durationSec)
  ) {
    return targetTrack;
  }

  return findAvailableAudioTrack(sequence, timelineIn, durationSec);
}

export function getNextTrackName(sequence: Sequence, kind: TrackCreateData['kind']): string {
  const baseLabel = TRACK_KIND_LABEL[kind];
  const labelPattern = new RegExp(`^${baseLabel}\\s+(\\d+)$`);
  let highestIndex = 0;

  for (const track of sequence.tracks) {
    if (track.kind !== kind) continue;

    const trimmedName = track.name.trim();
    if (trimmedName === baseLabel) {
      highestIndex = Math.max(highestIndex, 1);
      continue;
    }

    const match = labelPattern.exec(trimmedName);
    if (match) {
      highestIndex = Math.max(highestIndex, parseInt(match[1], 10));
    }
  }

  return `${baseLabel} ${highestIndex + 1}`;
}

/**
 * Calculates insertion index that matches common NLE lane layout.
 * - New video tracks are inserted above existing video tracks (below overlays).
 * - New audio tracks are appended below existing audio tracks.
 */
export function getDefaultTrackInsertPosition(
  sequence: Sequence,
  kind: TrackCreateData['kind'],
): number {
  if (kind === 'video') {
    let firstVideoIndex = -1;
    let firstLowerLaneIndex = -1;

    for (let index = 0; index < sequence.tracks.length; index += 1) {
      const track = sequence.tracks[index];

      if (firstVideoIndex === -1 && track.kind === 'video') {
        firstVideoIndex = index;
      }

      if (firstLowerLaneIndex === -1 && (track.kind === 'caption' || track.kind === 'audio')) {
        firstLowerLaneIndex = index;
      }
    }

    if (firstVideoIndex !== -1) {
      return firstVideoIndex;
    }

    if (firstLowerLaneIndex !== -1) {
      return firstLowerLaneIndex;
    }

    return sequence.tracks.length;
  }

  let lastAudioIndex = -1;
  for (let index = 0; index < sequence.tracks.length; index += 1) {
    if (sequence.tracks[index].kind === 'audio') {
      lastAudioIndex = index;
    }
  }

  return lastAudioIndex !== -1 ? lastAudioIndex + 1 : sequence.tracks.length;
}

interface SequenceSnapshotOptions {
  sequence: Sequence | null;
  getCurrentSequence: () => Sequence | null;
  logger: WarnLogger;
  missingSequenceMessage: string;
  missingSnapshotMessage: string;
  missingSnapshotContext: Record<string, unknown>;
}

export function getSequenceSnapshotOrWarn({
  sequence,
  getCurrentSequence,
  logger,
  missingSequenceMessage,
  missingSnapshotMessage,
  missingSnapshotContext,
}: SequenceSnapshotOptions): Sequence | null {
  if (!sequence) {
    logger.warn(missingSequenceMessage);
    return null;
  }

  const sequenceSnapshot = getCurrentSequence();
  if (!sequenceSnapshot) {
    logger.warn(missingSnapshotMessage, missingSnapshotContext);
    return null;
  }

  return sequenceSnapshot;
}

interface SourceClipOptions {
  sequenceSnapshot: Sequence;
  clipId: string;
  logger: WarnLogger;
  missingClipMessage: string;
  missingClipContext: Record<string, unknown>;
}

export function ensureSourceClipExistsOrWarn({
  sequenceSnapshot,
  clipId,
  logger,
  missingClipMessage,
  missingClipContext,
}: SourceClipOptions): boolean {
  if (findClipReference(sequenceSnapshot, clipId)) {
    return true;
  }

  logger.warn(missingClipMessage, missingClipContext);
  return false;
}

export async function runLinkedCompanionCommands<T extends { clipId: string }>(
  targets: T[],
  getCurrentSequence: () => Sequence | null,
  executeTarget: (target: T, latestSequence: Sequence) => Promise<void>,
): Promise<void> {
  for (const target of targets) {
    const latestSequence = getCurrentSequence();
    if (!latestSequence) {
      break;
    }

    if (!findClipReference(latestSequence, target.clipId)) {
      continue;
    }

    await executeTarget(target, latestSequence);
  }
}

const CLIP_AUDIO_BASE_KEYS = ['sequenceId', 'trackId', 'clipId'] as const;

export function buildClipAudioPayload(data: ClipAudioUpdateData): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sequenceId: data.sequenceId,
    trackId: data.trackId,
    clipId: data.clipId,
  };

  if (data.volumeDb !== undefined) {
    payload.volumeDb = data.volumeDb;
  }
  if (data.pan !== undefined) {
    payload.pan = data.pan;
  }
  if (data.muted !== undefined) {
    payload.muted = data.muted;
  }
  if (data.fadeInSec !== undefined) {
    payload.fadeInSec = data.fadeInSec;
  }
  if (data.fadeOutSec !== undefined) {
    payload.fadeOutSec = data.fadeOutSec;
  }

  return payload;
}

export function hasClipAudioUpdates(payload: Record<string, unknown>): boolean {
  return Object.keys(payload).length > CLIP_AUDIO_BASE_KEYS.length;
}

export function buildClipDeletionMap(
  sequenceSnapshot: Sequence,
  clipIds: string[],
): Array<{ clipId: string; trackId: string }> {
  const deletionMap: Array<{ clipId: string; trackId: string }> = [];

  for (const clipId of clipIds) {
    const ref = findClipReference(sequenceSnapshot, clipId);
    if (ref) {
      deletionMap.push({ clipId, trackId: ref.track.id });
    }
  }

  return deletionMap;
}

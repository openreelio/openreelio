import { createLogger } from '@/services/logger';
import { useProjectStore } from '@/stores/projectStore';
import { getClipTimelineEndSec } from '@/utils/clipTiming';
import { probeMedia } from '@/utils/ffmpeg';
import { executeAgentCommand } from './commandExecutor';
import type { Asset, CommandResult, Sequence, Track } from '@/types';

const logger = createLogger('AgentMediaInsertion');
const DEFAULT_INSERT_CLIP_DURATION_SEC = 10;

export interface AgentMediaInsertOptions {
  sequenceId: string;
  trackId: string;
  assetId: string;
  timelineStart: number;
  sourceIn?: number;
  sourceOut?: number;
  audioOnly?: boolean;
  autoExtractLinkedAudio?: boolean;
}

export interface AgentMediaInsertResult {
  insertResult: CommandResult;
  clipId: string;
  sequenceId: string;
  trackId: string;
  assetId: string;
  timelineStart: number;
  sourceIn?: number;
  sourceOut?: number;
  durationSec: number;
  linkedAudio?: {
    trackId: string;
    clipId: string;
    createdTrack: boolean;
  };
}

interface ResolvedSourceRange {
  sourceIn?: number;
  sourceOut?: number;
  durationSec: number;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function getAssetInsertDurationSec(asset: Asset): number {
  if (
    typeof asset.durationSec === 'number' &&
    Number.isFinite(asset.durationSec) &&
    asset.durationSec > 0
  ) {
    return asset.durationSec;
  }

  return DEFAULT_INSERT_CLIP_DURATION_SEC;
}

async function resolveAssetDurationSec(asset: Asset): Promise<number | null> {
  if (
    typeof asset.durationSec === 'number' &&
    Number.isFinite(asset.durationSec) &&
    asset.durationSec > 0
  ) {
    return asset.durationSec;
  }

  if (asset.kind !== 'video' && asset.kind !== 'audio') {
    return null;
  }

  try {
    const mediaInfo = await probeMedia(asset.uri);
    return Number.isFinite(mediaInfo.durationSec) && mediaInfo.durationSec > 0
      ? mediaInfo.durationSec
      : null;
  } catch (error) {
    logger.warn('Unable to probe inserted asset duration', {
      assetId: asset.id,
      uri: asset.uri,
      error,
    });
    return null;
  }
}

async function resolveSourceRange(
  asset: Asset,
  sourceInInput: unknown,
  sourceOutInput: unknown,
): Promise<ResolvedSourceRange> {
  const requestedSourceIn = finiteNonNegative(sourceInInput);
  const requestedSourceOut = finiteNonNegative(sourceOutInput);
  const hasExplicitRange = requestedSourceIn !== undefined || requestedSourceOut !== undefined;
  const assetDurationSec = await resolveAssetDurationSec(asset);
  const sourceIn = requestedSourceIn ?? 0;

  if (!hasExplicitRange && assetDurationSec == null) {
    return {
      durationSec: getAssetInsertDurationSec(asset),
    };
  }

  const sourceOut =
    requestedSourceOut ?? assetDurationSec ?? sourceIn + getAssetInsertDurationSec(asset);
  const clampedSourceOut =
    assetDurationSec != null ? Math.min(sourceOut, assetDurationSec) : sourceOut;

  if (sourceIn >= clampedSourceOut) {
    throw new Error(
      `Invalid source range for asset '${asset.id}': sourceOut must be greater than sourceIn.`,
    );
  }

  return {
    sourceIn,
    sourceOut: clampedSourceOut,
    durationSec: clampedSourceOut - sourceIn,
  };
}

function trackHasOverlap(track: Track, timelineIn: number, durationSec: number): boolean {
  const end = timelineIn + durationSec;
  return track.clips.some((clip) => {
    const clipStart = clip.place.timelineInSec;
    const clipEnd = getClipTimelineEndSec(clip);
    return timelineIn < clipEnd && end > clipStart;
  });
}

function canInsertClipOnTrack(track: Track, timelineIn: number, durationSec: number): boolean {
  return !track.locked && !trackHasOverlap(track, timelineIn, durationSec);
}

function findAvailableAudioTrack(
  sequence: Sequence,
  timelineIn: number,
  durationSec: number,
): Track | undefined {
  return sequence.tracks.find(
    (track) => track.kind === 'audio' && canInsertClipOnTrack(track, timelineIn, durationSec),
  );
}

function getNextAudioTrackName(sequence: Sequence): string {
  const baseLabel = 'Audio';
  let highestIndex = 0;

  for (const track of sequence.tracks) {
    if (track.kind !== 'audio') {
      continue;
    }

    const trimmedName = track.name.trim();
    if (trimmedName === baseLabel) {
      highestIndex = Math.max(highestIndex, 1);
      continue;
    }

    const match = /^Audio\s+(\d+)$/.exec(trimmedName);
    if (match) {
      highestIndex = Math.max(highestIndex, parseInt(match[1], 10));
    }
  }

  return `${baseLabel} ${highestIndex + 1}`;
}

function getDefaultAudioTrackInsertPosition(sequence: Sequence): number {
  let lastAudioIndex = -1;
  for (let index = 0; index < sequence.tracks.length; index += 1) {
    if (sequence.tracks[index].kind === 'audio') {
      lastAudioIndex = index;
    }
  }

  return lastAudioIndex !== -1 ? lastAudioIndex + 1 : sequence.tracks.length;
}

async function resolveAssetHasLinkedAudio(asset: Asset): Promise<boolean> {
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
    logger.warn('Unable to probe inserted video for audio stream detection', {
      assetId: asset.id,
      uri: asset.uri,
      error,
    });
    return false;
  }
}

function assertTrackCanReceiveAsset(asset: Asset, track: Track, audioOnly: boolean): void {
  if (asset.kind === 'video') {
    if (track.kind === 'audio') {
      if (audioOnly) {
        return;
      }

      throw new Error(
        `Video asset '${asset.id}' was targeted at audio track '${track.id}'. ` +
          'That creates an audio-only clip and will not show in preview. Use a video/overlay track, or set audioOnly true intentionally.',
      );
    }

    if (track.kind === 'video' || track.kind === 'overlay') {
      return;
    }
  }

  if (asset.kind === 'audio' && track.kind === 'audio') {
    return;
  }

  if (asset.kind === 'image' && (track.kind === 'video' || track.kind === 'overlay')) {
    return;
  }

  if (asset.kind === 'subtitle' && track.kind === 'caption') {
    return;
  }

  throw new Error(
    `Cannot place ${asset.kind} asset '${asset.id}' on ${track.kind} track '${track.id}'.`,
  );
}

async function rollbackAppliedCommands(appliedCount: number): Promise<boolean> {
  if (appliedCount === 0) {
    return true;
  }

  const project = useProjectStore.getState() as {
    undo?: () => Promise<{ success: boolean }>;
  };

  if (typeof project.undo !== 'function') {
    logger.warn('Media insert rollback skipped: undo API unavailable', { appliedCount });
    return false;
  }

  for (let index = 0; index < appliedCount; index += 1) {
    try {
      const result = await project.undo();
      if (!result.success) {
        return false;
      }
    } catch (error) {
      logger.error('Media insert rollback failed', {
        step: index + 1,
        appliedCount,
        error,
      });
      return false;
    }
  }

  return true;
}

function buildInsertPayload(options: {
  sequenceId: string;
  trackId: string;
  assetId: string;
  timelineStart: number;
  range: ResolvedSourceRange;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sequenceId: options.sequenceId,
    trackId: options.trackId,
    assetId: options.assetId,
    timelineStart: options.timelineStart,
  };

  if (options.range.sourceIn !== undefined) {
    payload.sourceIn = options.range.sourceIn;
  }
  if (options.range.sourceOut !== undefined) {
    payload.sourceOut = options.range.sourceOut;
  }

  return payload;
}

async function insertLinkedAudio(options: {
  asset: Asset;
  sequenceId: string;
  videoTrackId: string;
  videoClipId: string;
  timelineStart: number;
  range: ResolvedSourceRange;
  markApplied: () => void;
}): Promise<AgentMediaInsertResult['linkedAudio']> {
  const hasLinkedAudio = await resolveAssetHasLinkedAudio(options.asset);
  if (!hasLinkedAudio) {
    return undefined;
  }

  const project = useProjectStore.getState();
  const sequence = project.sequences.get(options.sequenceId);
  if (!sequence) {
    return undefined;
  }

  let createdAudioTrack = false;
  let audioTrack = findAvailableAudioTrack(
    sequence,
    options.timelineStart,
    options.range.durationSec,
  );

  if (!audioTrack) {
    const createTrackResult = await executeAgentCommand('CreateTrack', {
      sequenceId: options.sequenceId,
      kind: 'audio',
      name: getNextAudioTrackName(sequence),
      position: getDefaultAudioTrackInsertPosition(sequence),
    });
    options.markApplied();

    const createdTrackId = createTrackResult.createdIds[0];
    if (!createdTrackId) {
      throw new Error('CreateTrack did not return a linked audio track id');
    }

    createdAudioTrack = true;
    const refreshedProject = useProjectStore.getState();
    const refreshedSequence = refreshedProject.sequences.get(options.sequenceId);
    audioTrack = refreshedSequence?.tracks.find((track) => track.id === createdTrackId);
    if (!audioTrack) {
      throw new Error(`Created linked audio track '${createdTrackId}' was not found after refresh`);
    }
  }

  if (!audioTrack) {
    return undefined;
  }

  const audioResult = await executeAgentCommand(
    'InsertClip',
    buildInsertPayload({
      sequenceId: options.sequenceId,
      trackId: audioTrack.id,
      assetId: options.asset.id,
      timelineStart: options.timelineStart,
      range: options.range,
    }),
  );
  options.markApplied();

  const audioClipId = audioResult.createdIds[0];
  if (!audioClipId) {
    throw new Error('Linked audio InsertClip did not return a created clip id');
  }

  await executeAgentCommand('LinkClips', {
    sequenceId: options.sequenceId,
    clipRefs: [
      { trackId: options.videoTrackId, clipId: options.videoClipId },
      { trackId: audioTrack.id, clipId: audioClipId },
    ],
  });
  options.markApplied();

  await executeAgentCommand('SetClipMute', {
    sequenceId: options.sequenceId,
    trackId: options.videoTrackId,
    clipId: options.videoClipId,
    muted: true,
  });
  options.markApplied();

  return {
    trackId: audioTrack.id,
    clipId: audioClipId,
    createdTrack: createdAudioTrack,
  };
}

export async function insertAgentMediaClip(
  options: AgentMediaInsertOptions,
): Promise<AgentMediaInsertResult> {
  let appliedCommands = 0;
  const markApplied = (): void => {
    appliedCommands += 1;
  };

  try {
    const project = useProjectStore.getState();
    const sequence = project.sequences.get(options.sequenceId);
    if (!sequence) {
      throw new Error(`Sequence '${options.sequenceId}' not found`);
    }

    const track = sequence.tracks.find((entry) => entry.id === options.trackId);
    if (!track) {
      throw new Error(`Track '${options.trackId}' not found`);
    }

    const asset = project.assets.get(options.assetId);
    if (!asset) {
      throw new Error(`Asset '${options.assetId}' not found`);
    }

    const audioOnly = options.audioOnly === true;
    assertTrackCanReceiveAsset(asset, track, audioOnly);

    const range = await resolveSourceRange(asset, options.sourceIn, options.sourceOut);
    const insertResult = await executeAgentCommand(
      'InsertClip',
      buildInsertPayload({
        sequenceId: options.sequenceId,
        trackId: options.trackId,
        assetId: options.assetId,
        timelineStart: options.timelineStart,
        range,
      }),
    );
    markApplied();

    const clipId = insertResult.createdIds[0];
    if (!clipId) {
      throw new Error('InsertClip did not return a created clip id');
    }

    const shouldExtractLinkedAudio =
      options.autoExtractLinkedAudio !== false &&
      asset.kind === 'video' &&
      !audioOnly &&
      (track.kind === 'video' || track.kind === 'overlay');
    const linkedAudio = shouldExtractLinkedAudio
      ? await insertLinkedAudio({
          asset,
          sequenceId: options.sequenceId,
          videoTrackId: options.trackId,
          videoClipId: clipId,
          timelineStart: options.timelineStart,
          range,
          markApplied,
        })
      : undefined;

    return {
      insertResult,
      clipId,
      sequenceId: options.sequenceId,
      trackId: options.trackId,
      assetId: options.assetId,
      timelineStart: options.timelineStart,
      sourceIn: range.sourceIn,
      sourceOut: range.sourceOut,
      durationSec: range.durationSec,
      linkedAudio,
    };
  } catch (error) {
    const rolledBack = await rollbackAppliedCommands(appliedCommands);
    const message = error instanceof Error ? error.message : String(error);
    if (appliedCommands > 0 && !rolledBack) {
      throw new Error(`${message}. Automatic rollback failed after ${appliedCommands} command(s).`);
    }
    throw error;
  }
}

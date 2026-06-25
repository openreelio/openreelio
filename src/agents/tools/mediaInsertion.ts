import { useProjectStore } from '@/stores/projectStore';
import { executeAgentCommand } from './commandExecutor';
import type { Clip, CommandResult, Track } from '@/types';

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

function optionalFiniteNonNegative(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a finite non-negative number.`);
  }
  return value;
}

/**
 * Locates the linked audio partner clip created by the composite InsertMedia
 * command by following the primary clip's link group onto a different track.
 */
function findLinkedAudio(
  tracks: Track[],
  primaryTrackId: string,
  primaryClip: Clip,
  createdIds: string[],
): AgentMediaInsertResult['linkedAudio'] {
  const linkGroupId = primaryClip.linkGroupId;
  if (!linkGroupId) {
    return undefined;
  }

  for (const track of tracks) {
    if (track.id === primaryTrackId) {
      continue;
    }
    const audioClip = track.clips.find((clip) => clip.linkGroupId === linkGroupId);
    if (audioClip) {
      return {
        trackId: track.id,
        clipId: audioClip.id,
        createdTrack: createdIds.includes(track.id),
      };
    }
  }

  return undefined;
}

/**
 * Inserts media onto the timeline through the canonical backend `InsertMedia`
 * command, which performs the entire composite (primary clip insert plus
 * optional linked-audio extraction, track creation, linking, and muting) as a
 * single undoable history entry. This tool is a thin dispatcher that translates
 * its inputs into the command payload and reconstructs the result contract from
 * the refreshed project state.
 */
export async function insertAgentMediaClip(
  options: AgentMediaInsertOptions,
): Promise<AgentMediaInsertResult> {
  if (!Number.isFinite(options.timelineStart) || options.timelineStart < 0) {
    throw new Error('timelineStart must be a finite non-negative number.');
  }

  const insertResult = await executeAgentCommand('InsertMedia', {
    sequenceId: options.sequenceId,
    trackId: options.trackId,
    assetId: options.assetId,
    timelineStart: options.timelineStart,
    sourceIn: optionalFiniteNonNegative(options.sourceIn, 'sourceIn'),
    sourceOut: optionalFiniteNonNegative(options.sourceOut, 'sourceOut'),
    audioOnly: options.audioOnly === true,
    autoExtractLinkedAudio: options.autoExtractLinkedAudio !== false,
  });

  const clipId = insertResult.createdIds[0];
  if (!clipId) {
    throw new Error('InsertMedia did not return a created clip id');
  }

  const sequence = useProjectStore.getState().sequences.get(options.sequenceId);
  const track = sequence?.tracks.find((entry) => entry.id === options.trackId);
  const primaryClip = track?.clips.find((clip) => clip.id === clipId);

  return {
    insertResult,
    clipId,
    sequenceId: options.sequenceId,
    trackId: options.trackId,
    assetId: options.assetId,
    timelineStart: options.timelineStart,
    sourceIn: primaryClip?.range.sourceInSec,
    sourceOut: primaryClip?.range.sourceOutSec,
    durationSec: primaryClip?.place.durationSec ?? 0,
    linkedAudio:
      sequence && primaryClip
        ? findLinkedAudio(sequence.tracks, options.trackId, primaryClip, insertResult.createdIds)
        : undefined,
  };
}

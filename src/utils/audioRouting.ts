import type { MasterMixerState, TrackMixerState } from '@/stores/audioMixerStore';
import { dbToLinear } from './audioMeter';

export interface TrackPlaybackRoutingState {
  isAudible: boolean;
  trackGain: number;
  trackPan: number;
}

interface ResolveTrackPlaybackRoutingArgs {
  trackId: string;
  fallbackTrackVolume: number;
  trackStates: Map<string, TrackMixerState>;
  soloedTrackIds: Set<string>;
  masterMuted: boolean;
}

export function resolveTrackPlaybackRouting({
  trackId,
  fallbackTrackVolume,
  trackStates,
  soloedTrackIds,
  masterMuted,
}: ResolveTrackPlaybackRoutingArgs): TrackPlaybackRoutingState {
  const trackState = trackStates.get(trackId);
  const hasSoloSelection = soloedTrackIds.size > 0;
  const isSoloBlocked = hasSoloSelection && !soloedTrackIds.has(trackId);
  const isMuted = trackState?.muted ?? false;
  const isAudible = !masterMuted && !isMuted && !isSoloBlocked;

  return {
    isAudible,
    trackGain: isAudible ? (trackState ? dbToLinear(trackState.volumeDb) : fallbackTrackVolume) : 0,
    trackPan: trackState?.pan ?? 0,
  };
}

export function resolveMasterOutputGain(
  playbackVolume: number,
  playbackMuted: boolean,
  masterState: MasterMixerState,
): number {
  if (playbackMuted || masterState.muted) {
    return 0;
  }

  return playbackVolume * dbToLinear(masterState.volumeDb);
}

export function connectSourceToDestination(
  sourceNode: AudioNode,
  gainNode: AudioNode,
  pannerNode: AudioNode,
  destinationNode: AudioNode,
): void {
  sourceNode.connect(gainNode);
  gainNode.connect(pannerNode);
  pannerNode.connect(destinationNode);
}

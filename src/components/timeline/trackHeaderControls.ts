import type { TrackKind } from '@/types';

export interface TrackHeaderControls {
  showMute: boolean;
  showVisibility: boolean;
}

export function getTrackHeaderControls(kind: TrackKind): TrackHeaderControls {
  return {
    showMute: kind === 'audio',
    showVisibility: kind !== 'audio',
  };
}

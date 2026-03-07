import type { Track } from '@/types';

export interface TrackSwapTarget {
  trackId: string;
  name: string;
}

type TrackIdentity = Pick<Track, 'id' | 'kind'>;
type NamedTrackIdentity = Pick<Track, 'id' | 'kind' | 'name'>;
type TrackProtectionIdentity = Pick<Track, 'id' | 'kind' | 'isBaseTrack'>;

export function getTrackSwapTargets(
  tracks: NamedTrackIdentity[],
  sourceTrackId: string,
): TrackSwapTarget[] {
  const sourceTrack = tracks.find((track) => track.id === sourceTrackId);
  if (!sourceTrack) {
    return [];
  }

  return tracks
    .filter((track) => track.id !== sourceTrackId && track.kind === sourceTrack.kind)
    .map((track) => ({
      trackId: track.id,
      name: track.name,
    }));
}

export function resolveTrackSwapTargetId(
  tracks: TrackIdentity[],
  sourceTrackId: string,
  requestedIndex: number,
): string | null {
  const sourceIndex = tracks.findIndex((track) => track.id === sourceTrackId);
  if (sourceIndex < 0) {
    return null;
  }

  const clampedIndex = Math.max(0, Math.min(requestedIndex, tracks.length - 1));
  if (clampedIndex === sourceIndex) {
    return null;
  }

  return tracks[clampedIndex]?.id ?? null;
}

export function buildTrackSwapOrder(
  tracks: TrackIdentity[],
  sourceTrackId: string,
  targetTrackId: string,
): string[] | null {
  const sourceIndex = tracks.findIndex((track) => track.id === sourceTrackId);
  const targetIndex = tracks.findIndex((track) => track.id === targetTrackId);

  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return null;
  }

  if (tracks[sourceIndex]?.kind !== tracks[targetIndex]?.kind) {
    return null;
  }

  const reorderedTrackIds = tracks.map((track) => track.id);
  [reorderedTrackIds[sourceIndex], reorderedTrackIds[targetIndex]] = [
    reorderedTrackIds[targetIndex],
    reorderedTrackIds[sourceIndex],
  ];

  return reorderedTrackIds;
}

export function isProtectedBaseTrack(
  tracks: TrackProtectionIdentity[],
  targetTrackId: string,
): boolean {
  const targetTrack = tracks.find((track) => track.id === targetTrackId);
  if (!targetTrack) {
    return false;
  }

  if (targetTrack.isBaseTrack === true) {
    return true;
  }

  if (targetTrack.kind !== 'video' && targetTrack.kind !== 'audio') {
    return false;
  }

  const sameKindTracks = tracks.filter((track) => track.kind === targetTrack.kind);
  if (sameKindTracks.some((track) => track.isBaseTrack === true)) {
    return false;
  }

  const legacyCandidateTracks = sameKindTracks.filter(
    (track) => typeof track.isBaseTrack !== 'boolean',
  );
  if (legacyCandidateTracks.length === 0) {
    return false;
  }

  const earliestTrackId = [...legacyCandidateTracks].sort((a, b) => a.id.localeCompare(b.id))[0]
    ?.id;
  return earliestTrackId === targetTrackId;
}

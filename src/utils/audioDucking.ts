import type { Sequence } from '@/types';
import { findClipReference } from './clipLinking';

export interface AutoDuckTargets {
  speechTrackId: string;
  musicTrackId: string;
  musicClipId: string;
}

export type AutoDuckResolution =
  | { ok: true; targets: AutoDuckTargets }
  | { ok: false; reason: string };

export function resolveAutoDuckTargets(
  sequence: Sequence,
  selectedClipIds: string[],
): AutoDuckResolution {
  const audioTracks = sequence.tracks.filter((track) => track.kind === 'audio' && track.clips.length > 0);

  if (audioTracks.length < 2) {
    return {
      ok: false,
      reason: 'Auto-duck requires at least 2 audio tracks with clips.',
    };
  }

  if (selectedClipIds.length === 1) {
    const selectedClipRef = findClipReference(sequence, selectedClipIds[0]);
    if (selectedClipRef && selectedClipRef.track.kind === 'audio') {
      const speechTrackCandidates = audioTracks.filter(
        (track) => track.id !== selectedClipRef.track.id,
      );

      if (speechTrackCandidates.length !== 1) {
        return {
          ok: false,
          reason:
            'Auto-duck is ambiguous with multiple speech-track candidates. Select a music clip in a two-track audio setup.',
        };
      }

      return {
        ok: true,
        targets: {
          speechTrackId: speechTrackCandidates[0].id,
          musicTrackId: selectedClipRef.track.id,
          musicClipId: selectedClipRef.clip.id,
        },
      };
    }
  }

  if (audioTracks.length !== 2) {
    return {
      ok: false,
      reason: 'Select the music clip to duck when multiple audio tracks contain clips.',
    };
  }

  const speechTrack = audioTracks[0];
  const musicTrack = audioTracks[1];

  if (musicTrack.clips.length !== 1) {
    return {
      ok: false,
      reason: 'Select the music clip to duck when the target audio track contains multiple clips.',
    };
  }

  return {
    ok: true,
    targets: {
      speechTrackId: speechTrack.id,
      musicTrackId: musicTrack.id,
      musicClipId: musicTrack.clips[0].id,
    },
  };
}

import type { Asset, Clip, Sequence, Track } from '@/types';

export interface PlaybackAudioClipEntry {
  clip: Clip;
  asset: Asset;
  trackVolume: number;
  trackMuted: boolean;
}

const COMPANION_KEY_PRECISION = 6;

function normalizeKeyValue(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return value.toFixed(COMPANION_KEY_PRECISION);
}

function getSafeSpeed(clip: Clip): number {
  return clip.speed > 0 ? clip.speed : 1;
}

function createCompanionKey(clip: Clip): string {
  return [
    clip.assetId,
    normalizeKeyValue(clip.place.timelineInSec),
    normalizeKeyValue(clip.range.sourceInSec),
    normalizeKeyValue(clip.range.sourceOutSec),
    normalizeKeyValue(getSafeSpeed(clip)),
  ].join('|');
}

export function assetHasPlayableAudio(asset: Asset, trackKind?: Track['kind']): boolean {
  if (asset.kind === 'audio') {
    return true;
  }

  if (asset.kind !== 'video') {
    return false;
  }

  // Audio-track companions for video clips may be inserted before asset metadata
  // is fully populated (e.g., workspace auto-registration). Those clips are still
  // valid audio playback targets and should not be filtered out.
  if (trackKind === 'audio') {
    return true;
  }

  return Boolean(asset.audio);
}

export function collectPlaybackAudioClips(
  sequence: Sequence | null,
  assets: Map<string, Asset>,
): PlaybackAudioClipEntry[] {
  if (!sequence) {
    return [];
  }

  const audioCompanionKeys = new Set<string>();

  for (const track of sequence.tracks) {
    if (track.kind !== 'audio') {
      continue;
    }

    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId);
      if (!asset || !assetHasPlayableAudio(asset, track.kind)) {
        continue;
      }

      audioCompanionKeys.add(createCompanionKey(clip));
    }
  }

  const audioClips: PlaybackAudioClipEntry[] = [];

  for (const track of sequence.tracks) {
    if (track.muted) {
      continue;
    }

    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId);
      if (!asset || !assetHasPlayableAudio(asset, track.kind)) {
        continue;
      }

      const hasCompanionAudioOnAudioTrack =
        track.kind !== 'audio' &&
        asset.kind === 'video' &&
        audioCompanionKeys.has(createCompanionKey(clip));

      if (hasCompanionAudioOnAudioTrack) {
        continue;
      }

      audioClips.push({
        clip,
        asset,
        trackVolume: track.volume,
        trackMuted: track.muted,
      });
    }
  }

  return audioClips;
}

import type { Asset, Clip, Sequence } from '@/types';

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

export function assetHasPlayableAudio(asset: Asset): boolean {
  return asset.kind === 'audio' || (asset.kind === 'video' && Boolean(asset.audio));
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
      if (!asset || !assetHasPlayableAudio(asset)) {
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
      if (!asset || !assetHasPlayableAudio(asset)) {
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

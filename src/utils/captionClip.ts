import type { Asset, Clip, Track } from '@/types';

/** Asset ID used by backend-generated caption clips. */
export const CAPTION_CLIP_ASSET_ID = 'caption';

/**
 * Returns true when the clip should be treated as caption text instead of media.
 *
 * Caption clips can originate from:
 * - native caption tracks,
 * - subtitle assets,
 * - backend caption clips using the reserved caption asset id.
 */
export function isCaptionLikeClip(
  track: Pick<Track, 'kind'>,
  clip: Pick<Clip, 'assetId'>,
  asset: Pick<Asset, 'kind'> | null | undefined,
): boolean {
  if (track.kind === 'caption') {
    return true;
  }

  if (asset?.kind === 'subtitle') {
    return true;
  }

  return clip.assetId === CAPTION_CLIP_ASSET_ID;
}

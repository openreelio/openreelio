import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { normalizeFileUriToPath } from '@/utils/uri';
import type { Asset } from '@/types';

type AudioDecodingContext = Pick<AudioContext, 'decodeAudioData'>;

const audioPreviewPathCache = new Map<string, string>();

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();
}

export function assetMatchesWorkspaceRelativePath(asset: Asset, relativePath: string): boolean {
  if (!asset.relativePath) {
    return false;
  }

  return normalizeRelativePath(asset.relativePath) === normalizeRelativePath(relativePath);
}

export function clearCachedAudioPreview(assetId: string): void {
  audioPreviewPathCache.delete(assetId);
}

export function resolveAudioMediaUrl(uri: string): string {
  let url = normalizeFileUriToPath(uri.trim());
  if (!url.startsWith('asset://') && (url.startsWith('/') || url.match(/^[A-Za-z]:[\\/]/))) {
    url = convertFileSrc(url);
  }
  return url;
}

export async function ensureAudioPreviewUrl(assetId: string): Promise<string | null> {
  const previewPath = await invoke<string | null>('ensure_audio_preview_for_asset', { assetId });
  if (!previewPath) {
    return null;
  }

  audioPreviewPathCache.set(assetId, previewPath);
  return resolveAudioMediaUrl(previewPath);
}

async function fetchAndDecodeAudio(ctx: AudioDecodingContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return ctx.decodeAudioData(arrayBuffer);
}

export async function decodeAssetAudioBuffer(
  ctx: AudioDecodingContext,
  asset: Pick<Asset, 'id' | 'uri'>,
): Promise<{ buffer: AudioBuffer; usedPreview: boolean }> {
  try {
    return {
      buffer: await fetchAndDecodeAudio(ctx, resolveAudioMediaUrl(asset.uri)),
      usedPreview: false,
    };
  } catch (originalError) {
    const previewUrl = await ensureAudioPreviewUrl(asset.id);
    if (!previewUrl) {
      throw originalError;
    }

    return {
      buffer: await fetchAndDecodeAudio(ctx, previewUrl),
      usedPreview: true,
    };
  }
}

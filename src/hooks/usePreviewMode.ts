/**
 * usePreviewMode Hook
 *
 * Determines the optimal preview mode based on both proxy readiness and
 * whether the active frame can be represented by the proxy video renderer.
 */

import { useMemo } from 'react';
import type { Sequence, Asset, Clip, Track } from '@/types';

// =============================================================================
// Types
// =============================================================================

export type PreviewMode = 'video' | 'canvas';

export interface PreviewModeResult {
  /** The recommended preview mode */
  mode: PreviewMode;
  /** Human-readable reason for the mode selection */
  reason: string;
  /** Whether any proxies are currently generating */
  hasGeneratingProxy: boolean;
  /** Count of clips that would benefit from proxy */
  clipsNeedingProxy: number;
}

export interface UsePreviewModeOptions {
  /** The active sequence */
  sequence: Sequence | null;
  /** Assets map for looking up proxy status */
  assets: Map<string, Asset>;
  /** Current playhead time in seconds */
  currentTime: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

interface ActiveClipInfo {
  clip: Clip;
  track: Track;
  asset: Asset | null;
}

const FLOAT_EPSILON = 0.0001;

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= FLOAT_EPSILON;
}

/**
 * Find all active clips at the given timeline position.
 */
function findActiveClips(
  sequence: Sequence,
  currentTime: number,
  assets: Map<string, Asset>
): ActiveClipInfo[] {
  const activeClips: ActiveClipInfo[] = [];

  for (const track of sequence.tracks) {
    // Skip muted or hidden tracks
    if (track.muted || !track.visible) continue;

    for (const clip of track.clips) {
      const clipStart = clip.place.timelineInSec;
      const safeSpeed = clip.speed > 0 ? clip.speed : 1;
      const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
      const clipEnd = clipStart + clipDuration;

      if (currentTime >= clipStart && currentTime < clipEnd) {
        activeClips.push({
          clip,
          track,
          asset: assets.get(clip.assetId) ?? null,
        });
      }
    }
  }

  return activeClips;
}

/**
 * Check if a video asset has a ready proxy.
 */
function hasReadyProxy(asset: Asset): boolean {
  return asset.proxyStatus === 'ready' && !!asset.proxyUrl;
}

/**
 * Check if an asset is a video that could benefit from proxy.
 */
function isVideoAsset(asset: Asset): boolean {
  return asset.kind === 'video';
}

/**
 * Check whether a clip uses the identity transform expected by proxy mode.
 */
function hasIdentityTransform(clip: Clip): boolean {
  const { transform } = clip;

  return (
    nearlyEqual(transform.position.x, 0.5) &&
    nearlyEqual(transform.position.y, 0.5) &&
    nearlyEqual(transform.scale.x, 1) &&
    nearlyEqual(transform.scale.y, 1) &&
    nearlyEqual(transform.rotationDeg, 0) &&
    nearlyEqual(transform.anchor.x, 0.5) &&
    nearlyEqual(transform.anchor.y, 0.5)
  );
}

/**
 * Return a canvas-only reason when an active clip needs composition features
 * unsupported by proxy video mode.
 */
function getCanvasFallbackReason({ clip, track, asset }: ActiveClipInfo): string | null {
  // Audio tracks do not affect visual mode selection.
  if (track.kind === 'audio') {
    return null;
  }

  if (track.kind !== 'video') {
    return 'Overlay/caption compositing requires canvas mode';
  }

  if (!asset) {
    return 'Active clip asset is unavailable - using frame extraction';
  }

  if (!isVideoAsset(asset)) {
    return 'Active non-video clip requires canvas compositing';
  }

  if (track.blendMode !== 'normal') {
    return 'Track blend mode requires canvas compositing';
  }

  if (!hasIdentityTransform(clip)) {
    return 'Clip transform requires canvas compositing';
  }

  if (!nearlyEqual(clip.opacity, 1)) {
    return 'Clip opacity compositing requires canvas mode';
  }

  if (clip.effects.length > 0) {
    return 'Clip effects require canvas compositing';
  }

  return null;
}

// =============================================================================
// Hook
// =============================================================================

export function usePreviewMode({
  sequence,
  assets,
  currentTime,
}: UsePreviewModeOptions): PreviewModeResult {
  return useMemo(() => {
    // No sequence = canvas mode (show empty state)
    if (!sequence) {
      return {
        mode: 'canvas',
        reason: 'No sequence loaded',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
    }

    // Find all active clips at current time
    const activeClips = findActiveClips(sequence, currentTime, assets);

    // No clips at playhead = canvas mode (show black frame)
    if (activeClips.length === 0) {
      return {
        mode: 'canvas',
        reason: 'No clips at playhead',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
    }

    // If any active visual clip needs compositing, force canvas mode.
    const canvasFallbackReason = activeClips
      .map((activeClip) => getCanvasFallbackReason(activeClip))
      .find((reason): reason is string => reason !== null);

    if (canvasFallbackReason) {
      return {
        mode: 'canvas',
        reason: canvasFallbackReason,
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
    }

    // Analyze proxy readiness for active video clips on visual tracks.
    const videoClips = activeClips.filter(
      (activeClip): activeClip is ActiveClipInfo & { asset: Asset } =>
        activeClip.track.kind === 'video' && activeClip.asset !== null && isVideoAsset(activeClip.asset)
    );

    if (videoClips.length === 0) {
      return {
        mode: 'canvas',
        reason: 'No video clips (images use canvas)',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
    }

    const clipStatuses = videoClips.map(({ asset }) => ({
      hasProxy: hasReadyProxy(asset),
      isGenerating: asset.proxyStatus === 'generating',
      needsProxy: asset.proxyStatus !== 'notNeeded',
    }));

    const allHaveProxy = clipStatuses.every((status) => status.hasProxy);
    const anyGenerating = clipStatuses.some((status) => status.isGenerating);
    const clipsNeedingProxy = clipStatuses.filter((status) => status.needsProxy && !status.hasProxy).length;

    if (allHaveProxy) {
      return {
        mode: 'video',
        reason: 'All video clips have ready proxies',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
    }

    if (anyGenerating) {
      return {
        mode: 'canvas',
        reason: 'Proxies generating - using frame extraction',
        hasGeneratingProxy: true,
        clipsNeedingProxy,
      };
    }

    return {
      mode: 'canvas',
      reason: 'Some clips missing proxy - using frame extraction',
      hasGeneratingProxy: false,
      clipsNeedingProxy,
    };
  }, [sequence, assets, currentTime]);
}

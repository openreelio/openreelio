/**
 * usePreviewMode Hook
 *
 * Determines the optimal preview mode based on asset proxy availability.
 * Returns 'video' mode when all active video clips have ready proxies,
 * otherwise returns 'canvas' mode for frame-by-frame extraction.
 */

import { useMemo } from 'react';
import type { Sequence, Asset, Clip } from '@/types';

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
  asset: Asset;
}

/**
 * Find all active clips at the given timeline position
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
      const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
      const clipEnd = clipStart + clipDuration;

      // Check if clip is active at current time
      if (currentTime >= clipStart && currentTime < clipEnd) {
        const asset = assets.get(clip.assetId);
        if (asset) {
          activeClips.push({ clip, asset });
        }
      }
    }
  }

  return activeClips;
}

/**
 * Check if a video asset has a ready proxy
 */
function hasReadyProxy(asset: Asset): boolean {
  return asset.proxyStatus === 'ready' && !!asset.proxyUrl;
}

/**
 * Check if an asset is a video that could benefit from proxy
 */
function isVideoAsset(asset: Asset): boolean {
  return asset.kind === 'video';
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

    // Analyze video clips
    const videoClips = activeClips.filter(({ asset }) => isVideoAsset(asset));

    // No video clips = canvas mode (images work fine with canvas)
    if (videoClips.length === 0) {
      return {
        mode: 'canvas',
        reason: 'No video clips (images use canvas)',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
    }

    // Check proxy status for all video clips
    const clipStatuses = videoClips.map(({ asset }) => ({
      hasProxy: hasReadyProxy(asset),
      isGenerating: asset.proxyStatus === 'generating',
      isPending: asset.proxyStatus === 'pending',
      needsProxy: asset.proxyStatus !== 'notNeeded',
    }));

    const allHaveProxy = clipStatuses.every((s) => s.hasProxy);
    const anyGenerating = clipStatuses.some((s) => s.isGenerating);
    const clipsNeedingProxy = clipStatuses.filter((s) => s.needsProxy && !s.hasProxy).length;

    // All video clips have ready proxies = video mode
    if (allHaveProxy) {
      return {
        mode: 'video',
        reason: 'All video clips have ready proxies',
        hasGeneratingProxy: false,
        clipsNeedingProxy: 0,
      };
    }

    // Some proxies are generating = canvas mode (will switch when ready)
    if (anyGenerating) {
      return {
        mode: 'canvas',
        reason: 'Proxies generating - using frame extraction',
        hasGeneratingProxy: true,
        clipsNeedingProxy,
      };
    }

    // Fallback to canvas mode
    return {
      mode: 'canvas',
      reason: 'Some clips missing proxy - using frame extraction',
      hasGeneratingProxy: false,
      clipsNeedingProxy,
    };
  }, [sequence, assets, currentTime]);
}

/**
 * usePreviewSource Hook
 *
 * Determines the video source to display in the preview player based on:
 * 1. Selected asset (if any) - shows the selected asset
 * 2. Timeline playhead position - shows the clip at the current playhead position
 */

import { useMemo } from 'react';
import { useProjectStore } from '@/stores';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Sequence, Clip } from '@/types';
import { convertFileSrc } from '@tauri-apps/api/core';

// =============================================================================
// Types
// =============================================================================

export interface PreviewSource {
  /** Video source URL (converted for Tauri) */
  src: string;
  /** Original asset URI */
  assetUri: string;
  /** Asset ID */
  assetId: string;
  /** Asset name */
  name: string;
  /** Source type: 'asset' for direct asset preview, 'timeline' for clip from timeline */
  sourceType: 'asset' | 'timeline';
  /** For timeline source: the time offset within the source media */
  sourceOffset?: number;
  /** Thumbnail URL if available */
  thumbnail?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Find the clip at a given timeline position in a sequence
 */
function findClipAtTime(sequence: Sequence, time: number): Clip | null {
  for (const track of sequence.tracks) {
    // Only consider video tracks for preview
    if (track.kind !== 'video') continue;
    if (track.muted || !track.visible) continue;

    for (const clip of track.clips) {
      const clipStart = clip.place.timelineInSec;
      const safeSpeed = clip.speed > 0 ? clip.speed : 1;
      const clipDuration =
        (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
      const clipEnd = clipStart + clipDuration;

      if (time >= clipStart && time < clipEnd) {
        return clip;
      }
    }
  }
  return null;
}

/**
 * Calculate the source time for a clip at a given timeline position
 */
function getSourceTimeForClip(clip: Clip, timelineTime: number): number {
  const clipStart = clip.place.timelineInSec;
  const timeInClip = timelineTime - clipStart;
  const safeSpeed = clip.speed > 0 ? clip.speed : 1;
  const sourceTime = clip.range.sourceInSec + timeInClip * safeSpeed;
  return sourceTime;
}

// =============================================================================
// Hook
// =============================================================================

export function usePreviewSource(): PreviewSource | null {
  const selectedAssetId = useProjectStore((state) => state.selectedAssetId);
  const assets = useProjectStore((state) => state.assets);
  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const sequences = useProjectStore((state) => state.sequences);
  const { currentTime } = usePlaybackStore();

  return useMemo(() => {
    const sequence = activeSequenceId ? sequences.get(activeSequenceId) : undefined;

    // Priority 1: If an asset is selected in the project explorer, show it
    if (selectedAssetId) {
      const asset = assets.get(selectedAssetId);
      if (asset && (asset.kind === 'video' || asset.kind === 'image')) {
        return {
          src: convertFileSrc(asset.uri),
          assetUri: asset.uri,
          assetId: asset.id,
          name: asset.name,
          sourceType: 'asset',
          thumbnail: asset.thumbnailUrl,
        };
      }
    }

    // Priority 2: Show clip at current timeline position
    if (sequence) {
      const clip = findClipAtTime(sequence, currentTime);
      if (clip) {
        const asset = assets.get(clip.assetId);
        if (asset && (asset.kind === 'video' || asset.kind === 'image')) {
          const sourceTime = getSourceTimeForClip(clip, currentTime);
          return {
            src: convertFileSrc(asset.uri),
            assetUri: asset.uri,
            assetId: asset.id,
            name: asset.name,
            sourceType: 'timeline',
            sourceOffset: sourceTime,
            thumbnail: asset.thumbnailUrl,
          };
        }
      }
    }

    // No preview source available
    return null;
  }, [selectedAssetId, assets, activeSequenceId, sequences, currentTime]);
}

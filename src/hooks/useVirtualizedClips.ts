/**
 * useVirtualizedClips Hook
 *
 * Provides horizontal virtualization for timeline clips.
 * Only renders clips that are visible within the current viewport,
 * plus a buffer zone for smooth scrolling.
 *
 * This significantly improves performance for projects with many clips
 * by avoiding rendering of off-screen clips.
 */

import { useMemo } from 'react';
import type { Clip, TimeSec } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface VirtualizationConfig {
  /** Pixels per second zoom level */
  zoom: number;
  /** Current horizontal scroll position in pixels */
  scrollX: number;
  /** Visible viewport width in pixels */
  viewportWidth: number;
  /** Buffer zone in pixels on each side for pre-rendering (default: 200) */
  bufferPx?: number;
}

export interface VirtualizedClip extends Clip {
  /** Precomputed left position in pixels */
  leftPx: number;
  /** Precomputed width in pixels */
  widthPx: number;
  /** Clip duration in seconds */
  durationSec: TimeSec;
}

export interface UseVirtualizedClipsResult {
  /** Clips that should be rendered (within viewport + buffer) */
  visibleClips: VirtualizedClip[];
  /** Total number of clips */
  totalClips: number;
  /** Number of clips being rendered */
  renderedClips: number;
  /** Whether virtualization is active (some clips hidden) */
  isVirtualized: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BUFFER_PX = 200;
const MIN_CLIP_WIDTH_PX = 4;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Calculate clip position and dimensions in pixels
 */
function computeClipMetrics(clip: Clip, zoom: number): VirtualizedClip {
  const safeSpeed = clip.speed > 0 ? clip.speed : 1;
  const durationSec = (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
  const leftPx = clip.place.timelineInSec * zoom;
  const widthPx = Math.max(durationSec * zoom, MIN_CLIP_WIDTH_PX);

  return {
    ...clip,
    leftPx,
    widthPx,
    durationSec,
  };
}

/**
 * Check if a clip is within the visible viewport (including buffer)
 */
function isClipVisible(
  clipLeft: number,
  clipWidth: number,
  viewportStart: number,
  viewportEnd: number
): boolean {
  const clipRight = clipLeft + clipWidth;
  // Clip is visible if it overlaps with the viewport
  return clipRight > viewportStart && clipLeft < viewportEnd;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for virtualizing timeline clips based on viewport visibility.
 *
 * @param clips - Array of clips to virtualize
 * @param config - Virtualization configuration
 * @returns Object containing visible clips and virtualization stats
 *
 * @example
 * ```tsx
 * const { visibleClips, isVirtualized } = useVirtualizedClips(clips, {
 *   zoom: 100,
 *   scrollX: 0,
 *   viewportWidth: 1200,
 * });
 *
 * return (
 *   <>
 *     {visibleClips.map(clip => (
 *       <Clip key={clip.id} clip={clip} style={{ left: clip.leftPx }} />
 *     ))}
 *   </>
 * );
 * ```
 */
export function useVirtualizedClips(
  clips: Clip[],
  config: VirtualizationConfig
): UseVirtualizedClipsResult {
  const { zoom, scrollX, viewportWidth, bufferPx = DEFAULT_BUFFER_PX } = config;

  return useMemo(() => {
    // Calculate viewport boundaries with buffer
    const viewportStart = Math.max(0, scrollX - bufferPx);
    const viewportEnd = scrollX + viewportWidth + bufferPx;

    // Compute metrics for all clips and filter to visible ones
    const visibleClips: VirtualizedClip[] = [];

    for (const clip of clips) {
      const virtualizedClip = computeClipMetrics(clip, zoom);

      if (
        isClipVisible(
          virtualizedClip.leftPx,
          virtualizedClip.widthPx,
          viewportStart,
          viewportEnd
        )
      ) {
        visibleClips.push(virtualizedClip);
      }
    }

    return {
      visibleClips,
      totalClips: clips.length,
      renderedClips: visibleClips.length,
      isVirtualized: visibleClips.length < clips.length,
    };
  }, [clips, zoom, scrollX, viewportWidth, bufferPx]);
}

// =============================================================================
// Additional Utilities
// =============================================================================

/**
 * Sort clips by their timeline position for optimal rendering order
 */
export function sortClipsByPosition(clips: VirtualizedClip[]): VirtualizedClip[] {
  return [...clips].sort((a, b) => a.leftPx - b.leftPx);
}

/**
 * Calculate the total timeline extent based on clips
 */
export function calculateTimelineExtent(clips: Clip[]): {
  minTimeSec: number;
  maxTimeSec: number;
  totalDurationSec: number;
} {
  if (clips.length === 0) {
    return { minTimeSec: 0, maxTimeSec: 0, totalDurationSec: 0 };
  }

  let minTimeSec = Infinity;
  let maxTimeSec = 0;

  for (const clip of clips) {
    const startTime = clip.place.timelineInSec;
    const speed = clip.speed > 0 ? clip.speed : 1;
    const duration = (clip.range.sourceOutSec - clip.range.sourceInSec) / speed;
    const endTime = startTime + duration;

    minTimeSec = Math.min(minTimeSec, startTime);
    maxTimeSec = Math.max(maxTimeSec, endTime);
  }

  return {
    minTimeSec: minTimeSec === Infinity ? 0 : minTimeSec,
    maxTimeSec,
    totalDurationSec: maxTimeSec - (minTimeSec === Infinity ? 0 : minTimeSec),
  };
}

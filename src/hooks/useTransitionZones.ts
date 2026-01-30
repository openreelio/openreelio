/**
 * useTransitionZones Hook
 *
 * Finds adjacent clip pairs on a track that can have transitions between them.
 * Returns transition zone data for rendering TransitionZone components.
 */

import { useMemo } from 'react';
import type { Clip } from '@/types';

// =============================================================================
// Types
// =============================================================================

/** A zone between two adjacent clips where a transition can be placed */
export interface TransitionZoneData {
  /** ID of the first clip (before the junction) */
  clipAId: string;
  /** ID of the second clip (after the junction) */
  clipBId: string;
  /** Junction point in seconds (where clips meet or overlap center) */
  junctionSec: number;
}

/** Options for transition zone detection */
export interface TransitionZoneOptions {
  /** Maximum gap in seconds to consider clips adjacent (default: 0.1) */
  gapTolerance?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_GAP_TOLERANCE = 0.1; // 100ms

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validates and returns a safe numeric value, falling back if invalid.
 */
function safeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Validates that a clip has valid numeric place data.
 */
function hasValidPlaceData(clip: Clip): boolean {
  const { timelineInSec, durationSec } = clip?.place ?? {};
  return (
    typeof timelineInSec === 'number' &&
    Number.isFinite(timelineInSec) &&
    timelineInSec >= 0 &&
    typeof durationSec === 'number' &&
    Number.isFinite(durationSec) &&
    durationSec > 0
  );
}

/**
 * Sort clips by timeline position, filtering out clips with invalid numeric data.
 */
function sortClipsByPosition(clips: Clip[]): Clip[] {
  return [...clips]
    .filter(hasValidPlaceData)
    .sort((a, b) => {
      // Both clips validated, but use safeNumber for extra defense
      const aTime = safeNumber(a.place.timelineInSec, 0);
      const bTime = safeNumber(b.place.timelineInSec, 0);
      return aTime - bTime;
    });
}

/**
 * Get the end time of a clip on the timeline with validation.
 */
function getClipEndTime(clip: Clip): number {
  const start = safeNumber(clip.place.timelineInSec, 0);
  const duration = safeNumber(clip.place.durationSec, 0);
  return start + duration;
}

/**
 * Calculate junction point between two clips with validation.
 * Returns midpoint for overlapping clips, otherwise the first clip's end.
 */
function calculateJunctionPoint(clipA: Clip, clipB: Clip): number {
  const clipAEnd = getClipEndTime(clipA);
  const clipBStart = safeNumber(clipB.place.timelineInSec, clipAEnd);

  if (clipAEnd > clipBStart) {
    // Overlapping - return midpoint
    const midpoint = (clipAEnd + clipBStart) / 2;
    return Number.isFinite(midpoint) ? midpoint : clipAEnd;
  }
  // Adjacent or gapped - return clipA end
  return clipAEnd;
}

/**
 * Check if two clips are adjacent (touching or overlapping within tolerance).
 * Validates tolerance input to prevent issues with negative or infinite values.
 */
function areClipsAdjacent(clipA: Clip, clipB: Clip, tolerance: number): boolean {
  const safeTolerance = Math.max(0, safeNumber(tolerance, DEFAULT_GAP_TOLERANCE));
  const clipAEnd = getClipEndTime(clipA);
  const clipBStart = safeNumber(clipB.place.timelineInSec, 0);
  const gap = clipBStart - clipAEnd;

  // Adjacent if gap is within tolerance (including negative for overlap)
  return Number.isFinite(gap) && gap <= safeTolerance;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Find all adjacent clip pairs where transitions can be placed
 *
 * @param clips - Array of clips to analyze
 * @param options - Configuration options
 * @returns Array of transition zone data
 */
export function useTransitionZones(
  clips: Clip[],
  options: TransitionZoneOptions = {}
): TransitionZoneData[] {
  const { gapTolerance = DEFAULT_GAP_TOLERANCE } = options;

  return useMemo(() => {
    // Defensive check for invalid clips array
    if (!Array.isArray(clips) || clips.length < 2) {
      return [];
    }

    // Validate gapTolerance is a valid number
    const safeTolerance = safeNumber(gapTolerance, DEFAULT_GAP_TOLERANCE);

    // sortClipsByPosition already filters invalid place data via hasValidPlaceData
    const sortedClips = sortClipsByPosition(clips);

    if (sortedClips.length < 2) {
      return [];
    }

    // Find adjacent pairs with duplicate ID detection
    const zones: TransitionZoneData[] = [];
    const seenPairs = new Set<string>();

    for (let i = 0; i < sortedClips.length - 1; i++) {
      const clipA = sortedClips[i];
      const clipB = sortedClips[i + 1];

      // Skip if either clip has no valid ID
      if (!clipA.id || !clipB.id) {
        continue;
      }

      // Prevent duplicate pairs (shouldn't happen but defensive check)
      const pairKey = `${clipA.id}:${clipB.id}`;
      if (seenPairs.has(pairKey)) {
        continue;
      }

      if (areClipsAdjacent(clipA, clipB, safeTolerance)) {
        seenPairs.add(pairKey);
        const junctionSec = calculateJunctionPoint(clipA, clipB);

        // Validate junction point is valid before adding
        if (Number.isFinite(junctionSec) && junctionSec >= 0) {
          zones.push({
            clipAId: clipA.id,
            clipBId: clipB.id,
            junctionSec,
          });
        }
      }
    }

    return zones;
  }, [clips, gapTolerance]);
}

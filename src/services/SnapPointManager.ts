/**
 * SnapPointManager Service
 *
 * Optimized snap point management with incremental updates.
 * Instead of recalculating all snap points on every change,
 * this manager only updates snap points for clips that have changed.
 *
 * Performance benefits:
 * - O(1) for single clip updates instead of O(n) for all clips
 * - Cached snap point arrays with dirty tracking
 * - Separated snap sources for fine-grained invalidation
 *
 * @module services/SnapPointManager
 */

import type { SnapPoint, Clip, Sequence } from '@/types';
import { createLogger } from '@/services/logger';
import { calculateSnapThreshold } from '@/constants/precision';

const logger = createLogger('SnapPointManager');

// =============================================================================
// Types
// =============================================================================

/**
 * Snap point source types.
 */
export type SnapPointSource = 'clip-in' | 'clip-out' | 'playhead' | 'grid' | 'marker';

/**
 * Internal snap point with metadata.
 */
interface ManagedSnapPoint extends SnapPoint {
  sourceId?: string;
  source: SnapPointSource;
}

/**
 * Configuration for the snap point manager.
 */
export interface SnapPointManagerConfig {
  /** Whether snapping is enabled */
  enabled: boolean;
  /** Whether to snap to clip edges */
  snapToClips: boolean;
  /** Whether to snap to grid lines */
  snapToGrid: boolean;
  /** Whether to snap to playhead */
  snapToPlayhead: boolean;
  /** Whether to snap to markers */
  snapToMarkers: boolean;
  /** Current zoom level (pixels per second) */
  zoom: number;
  /** Grid interval in seconds */
  gridInterval: number;
  /** Timeline duration in seconds */
  duration: number;
}

/**
 * Result from snap calculation.
 */
export interface SnapResult {
  snapped: boolean;
  time: number;
  snapPoint: SnapPoint | null;
  distance: number;
}

// =============================================================================
// SnapPointManager Class
// =============================================================================

/**
 * Manages snap points with incremental updates for performance.
 *
 * Usage:
 * 1. Create instance with initial config
 * 2. Update clips incrementally via addClip/removeClip/updateClip
 * 3. Get snap points via getSnapPoints()
 * 4. Use snapToNearest() for snap calculations
 */
export class SnapPointManager {
  private config: SnapPointManagerConfig;

  // Separated snap point storage for incremental updates
  private clipSnapPoints: Map<string, ManagedSnapPoint[]> = new Map();
  private gridSnapPoints: ManagedSnapPoint[] = [];
  private markerSnapPoints: ManagedSnapPoint[] = [];
  private playheadSnapPoint: ManagedSnapPoint | null = null;

  // Cache for combined snap points
  private cachedSnapPoints: SnapPoint[] | null = null;
  private isDirty: boolean = true;

  // Stats
  private updateCount: number = 0;
  private cacheHits: number = 0;
  private cacheMisses: number = 0;

  constructor(config: Partial<SnapPointManagerConfig> = {}) {
    this.config = {
      enabled: true,
      snapToClips: true,
      snapToGrid: true,
      snapToPlayhead: true,
      snapToMarkers: true,
      zoom: 100,
      gridInterval: 1,
      duration: 60,
      ...config,
    };

    this.regenerateGridSnapPoints();
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Update configuration and invalidate caches as needed.
   */
  updateConfig(config: Partial<SnapPointManagerConfig>): void {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...config };

    // Check what changed and invalidate accordingly
    // Using explicit parentheses for clarity on operator precedence
    const gridIntervalChanged = config.gridInterval !== undefined && config.gridInterval !== oldConfig.gridInterval;
    const durationChanged = config.duration !== undefined && config.duration !== oldConfig.duration;
    const snapToGridChanged = config.snapToGrid !== undefined && config.snapToGrid !== oldConfig.snapToGrid;

    if (gridIntervalChanged || durationChanged || snapToGridChanged) {
      this.regenerateGridSnapPoints();
    }

    // Always invalidate cache when config changes
    this.invalidateCache();
  }

  /**
   * Get current snap threshold based on zoom.
   */
  getSnapThreshold(): number {
    return calculateSnapThreshold(this.config.zoom);
  }

  // ===========================================================================
  // Clip Management (Incremental)
  // ===========================================================================

  /**
   * Add or update snap points for a clip.
   * Only affects this clip's snap points, not others.
   */
  updateClip(clip: Clip): void {
    const clipId = clip.id;
    const inTime = clip.place.timelineInSec;
    const safeSpeed = clip.speed > 0 ? clip.speed : 1;
    const outTime = inTime + (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;

    const snapPoints: ManagedSnapPoint[] = [
      {
        time: inTime,
        type: 'clip-start',
        source: 'clip-in',
        sourceId: clipId,
      },
      {
        time: outTime,
        type: 'clip-end',
        source: 'clip-out',
        sourceId: clipId,
      },
    ];

    this.clipSnapPoints.set(clipId, snapPoints);
    this.invalidateCache();
    this.updateCount++;
  }

  /**
   * Remove snap points for a clip.
   */
  removeClip(clipId: string): void {
    if (this.clipSnapPoints.has(clipId)) {
      this.clipSnapPoints.delete(clipId);
      this.invalidateCache();
      this.updateCount++;
    }
  }

  /**
   * Bulk update clips from a sequence.
   * More efficient than individual updateClip calls for initial load.
   */
  updateFromSequence(sequence: Sequence | null): void {
    // Clear existing clip snap points
    this.clipSnapPoints.clear();

    if (!sequence) {
      this.invalidateCache();
      return;
    }

    // Add snap points for all clips
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        const inTime = clip.place.timelineInSec;
        const safeSpeed = clip.speed > 0 ? clip.speed : 1;
        const outTime = inTime + (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;

        const snapPoints: ManagedSnapPoint[] = [
          {
            time: inTime,
            type: 'clip-start',
            source: 'clip-in',
            sourceId: clip.id,
          },
          {
            time: outTime,
            type: 'clip-end',
            source: 'clip-out',
            sourceId: clip.id,
          },
        ];

        this.clipSnapPoints.set(clip.id, snapPoints);
      }
    }

    this.invalidateCache();
    this.updateCount++;

    logger.debug('Updated snap points from sequence', {
      trackCount: sequence.tracks.length,
      clipCount: this.clipSnapPoints.size,
    });
  }

  // ===========================================================================
  // Playhead
  // ===========================================================================

  /**
   * Update playhead position for snapping.
   */
  updatePlayhead(time: number): void {
    this.playheadSnapPoint = {
      time,
      type: 'playhead',
      source: 'playhead',
    };
    this.invalidateCache();
  }

  // ===========================================================================
  // Markers
  // ===========================================================================

  /**
   * Update markers for snapping.
   */
  updateMarkers(markerTimes: number[]): void {
    this.markerSnapPoints = markerTimes.map(time => ({
      time,
      type: 'marker' as const,
      source: 'marker' as SnapPointSource,
    }));
    this.invalidateCache();
  }

  // ===========================================================================
  // Grid
  // ===========================================================================

  /**
   * Regenerate grid snap points based on current config.
   */
  private regenerateGridSnapPoints(): void {
    if (!this.config.snapToGrid || this.config.gridInterval <= 0) {
      this.gridSnapPoints = [];
      return;
    }

    const points: ManagedSnapPoint[] = [];
    const { duration, gridInterval } = this.config;

    for (let time = 0; time <= duration; time += gridInterval) {
      points.push({
        time,
        type: 'grid',
        source: 'grid',
      });
    }

    this.gridSnapPoints = points;
    this.invalidateCache();
  }

  // ===========================================================================
  // Snap Point Access
  // ===========================================================================

  /**
   * Get all snap points (uses cache when available).
   */
  getSnapPoints(): SnapPoint[] {
    if (!this.config.enabled) {
      return [];
    }

    if (this.cachedSnapPoints !== null && !this.isDirty) {
      this.cacheHits++;
      return this.cachedSnapPoints;
    }

    this.cacheMisses++;
    this.rebuildCache();
    return this.cachedSnapPoints!;
  }

  /**
   * Rebuild the combined snap points cache.
   * Preserves clipId for proper exclusion filtering.
   */
  private rebuildCache(): void {
    const points: SnapPoint[] = [];

    // Add clip snap points - preserve clipId from sourceId
    if (this.config.snapToClips) {
      for (const clipPoints of this.clipSnapPoints.values()) {
        for (const point of clipPoints) {
          points.push({
            time: point.time,
            type: point.type,
            clipId: point.sourceId,
          });
        }
      }
    }

    // Add grid snap points
    if (this.config.snapToGrid) {
      for (const point of this.gridSnapPoints) {
        points.push({ time: point.time, type: point.type });
      }
    }

    // Add marker snap points
    if (this.config.snapToMarkers) {
      for (const point of this.markerSnapPoints) {
        points.push({ time: point.time, type: point.type });
      }
    }

    // Add playhead snap point
    if (this.config.snapToPlayhead && this.playheadSnapPoint) {
      points.push({
        time: this.playheadSnapPoint.time,
        type: this.playheadSnapPoint.type,
      });
    }

    this.cachedSnapPoints = points;
    this.isDirty = false;
  }

  /**
   * Invalidate the cache, forcing rebuild on next access.
   */
  private invalidateCache(): void {
    this.isDirty = true;
    this.cachedSnapPoints = null;
  }

  // ===========================================================================
  // Snapping Calculation
  // ===========================================================================

  /**
   * Find the nearest snap point to a given time.
   *
   * @param time - Time to snap from
   * @param threshold - Optional override for snap threshold
   * @param excludeClipId - Optional clip ID to exclude from snapping
   * @returns Snap result with snapped time and metadata
   */
  snapToNearest(
    time: number,
    threshold?: number,
    excludeClipId?: string
  ): SnapResult {
    if (!this.config.enabled) {
      return { snapped: false, time, snapPoint: null, distance: Infinity };
    }

    const snapThreshold = threshold ?? this.getSnapThreshold();
    const snapPoints = this.getSnapPoints();

    let nearestPoint: SnapPoint | null = null;
    let nearestDistance = Infinity;

    for (const point of snapPoints) {
      // Skip excluded clip's snap points using clipId for accurate filtering
      // This avoids accidentally excluding grid/marker points at the same time
      if (excludeClipId && point.clipId === excludeClipId) {
        continue;
      }

      const distance = Math.abs(point.time - time);
      if (distance < nearestDistance && distance <= snapThreshold) {
        nearestDistance = distance;
        nearestPoint = point;
      }
    }

    if (nearestPoint) {
      return {
        snapped: true,
        time: nearestPoint.time,
        snapPoint: nearestPoint,
        distance: nearestDistance,
      };
    }

    return { snapped: false, time, snapPoint: null, distance: Infinity };
  }

  /**
   * Check if a time is within snap threshold of any snap point.
   */
  isNearSnapPoint(time: number, threshold?: number): boolean {
    const result = this.snapToNearest(time, threshold);
    return result.snapped;
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get the snap point count without affecting cache statistics.
   * Used internally by getStats() to avoid side effects.
   */
  private getSnapPointCountInternal(): number {
    if (!this.config.enabled) {
      return 0;
    }

    // If cache is valid, use cached count without incrementing stats
    if (this.cachedSnapPoints !== null && !this.isDirty) {
      return this.cachedSnapPoints.length;
    }

    // Calculate count without caching to avoid side effects
    let count = 0;

    if (this.config.snapToClips) {
      for (const clipPoints of this.clipSnapPoints.values()) {
        count += clipPoints.length;
      }
    }

    if (this.config.snapToGrid) {
      count += this.gridSnapPoints.length;
    }

    if (this.config.snapToMarkers) {
      count += this.markerSnapPoints.length;
    }

    if (this.config.snapToPlayhead && this.playheadSnapPoint) {
      count += 1;
    }

    return count;
  }

  /**
   * Get performance statistics.
   * Note: This method does not modify cache statistics.
   */
  getStats(): {
    clipCount: number;
    totalSnapPoints: number;
    updateCount: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number;
  } {
    const totalCacheAccess = this.cacheHits + this.cacheMisses;

    return {
      clipCount: this.clipSnapPoints.size,
      totalSnapPoints: this.getSnapPointCountInternal(),
      updateCount: this.updateCount,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRate: totalCacheAccess > 0 ? this.cacheHits / totalCacheAccess : 0,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.updateCount = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /**
   * Clear all snap points.
   */
  clear(): void {
    this.clipSnapPoints.clear();
    this.gridSnapPoints = [];
    this.markerSnapPoints = [];
    this.playheadSnapPoint = null;
    this.invalidateCache();
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

/**
 * Global snap point manager instance.
 */
export const snapPointManager = new SnapPointManager();

// =============================================================================
// React Hook
// =============================================================================

import { useMemo, useCallback, useRef, useEffect } from 'react';

/**
 * Hook to use the snap point manager with React state integration.
 *
 * @param sequence - Current sequence for clip snap points
 * @param config - Manager configuration
 * @returns Snap utilities and snap points
 */
export function useSnapPointManager(
  sequence: Sequence | null,
  config: Partial<SnapPointManagerConfig>
): {
  snapPoints: SnapPoint[];
  snapThreshold: number;
  snapToNearest: (time: number, excludeClipId?: string) => SnapResult;
  updatePlayhead: (time: number) => void;
  stats: ReturnType<SnapPointManager['getStats']>;
} {
  const managerRef = useRef<SnapPointManager | null>(null);

  // Create manager on first render
  if (!managerRef.current) {
    managerRef.current = new SnapPointManager(config);
  }

  const manager = managerRef.current;

  // Update config when it changes
  useEffect(() => {
    manager.updateConfig(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally depend on specific properties only
  }, [manager, config.enabled, config.snapToClips, config.snapToGrid, config.snapToPlayhead, config.snapToMarkers, config.zoom, config.gridInterval, config.duration]);

  // Update from sequence when it changes
  useEffect(() => {
    manager.updateFromSequence(sequence);
  }, [manager, sequence]);

  // Memoize snap points - recalculate when sequence changes or relevant config changes
  const snapPoints = useMemo(
    () => manager.getSnapPoints(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, sequence, config.enabled, config.snapToClips, config.snapToGrid, config.snapToPlayhead, config.snapToMarkers, config.gridInterval, config.duration]
  );

  const snapThreshold = useMemo(
    () => manager.getSnapThreshold(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoom affects threshold calculation
    [manager, config.zoom]
  );

  const snapToNearest = useCallback(
    (time: number, excludeClipId?: string) => manager.snapToNearest(time, undefined, excludeClipId),
    [manager]
  );

  const updatePlayhead = useCallback(
    (time: number) => manager.updatePlayhead(time),
    [manager]
  );

  return {
    snapPoints,
    snapThreshold,
    snapToNearest,
    updatePlayhead,
    stats: manager.getStats(),
  };
}

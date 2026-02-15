/**
 * Timeline Track Drop Target Utilities
 *
 * Resolves which track row should receive a drop/drag action from viewport
 * coordinates. Uses DOM row hit-testing first (accurate for mixed row heights),
 * then falls back to index math when row metadata is unavailable.
 */

import type { Sequence, Track } from '@/types';

const TRACK_ROW_SELECTOR = '[data-track-row="true"][data-track-id]';

/** Resolved drop target track information. */
export interface TrackDropTarget {
  track: Track;
  trackIndex: number;
}

export interface ResolveTrackDropTargetOptions {
  /** Sequence containing the track list in visual order. */
  sequence: Sequence;
  /** Timeline tracks container element. */
  container: HTMLElement;
  /** Pointer Y position in viewport coordinates. */
  clientY: number;
  /** Optional virtual scroll offset (used by fallback mode). */
  scrollY?: number;
  /** Optional fallback track height in pixels (used by fallback mode). */
  fallbackTrackHeight?: number;
}

interface RowCandidate {
  track: Track;
  trackIndex: number;
  top: number;
  bottom: number;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function readRowCandidates(sequence: Sequence, container: HTMLElement): RowCandidate[] {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(TRACK_ROW_SELECTOR));
  if (rows.length === 0) return [];

  const candidates: RowCandidate[] = [];
  for (const row of rows) {
    const trackId = row.dataset.trackId;
    if (!trackId) continue;

    const trackIndex = sequence.tracks.findIndex((track) => track.id === trackId);
    if (trackIndex < 0) continue;

    const rect = row.getBoundingClientRect();
    if (!isFiniteNumber(rect.top) || !isFiniteNumber(rect.bottom) || rect.bottom < rect.top) {
      continue;
    }

    candidates.push({
      track: sequence.tracks[trackIndex],
      trackIndex,
      top: rect.top,
      bottom: rect.bottom,
    });
  }

  return candidates.sort((a, b) => (a.top === b.top ? a.trackIndex - b.trackIndex : a.top - b.top));
}

function resolveByDomRows(
  sequence: Sequence,
  container: HTMLElement,
  clientY: number,
): TrackDropTarget | null {
  const rows = readRowCandidates(sequence, container);
  if (rows.length === 0) return null;

  const directHit = rows.find((row) => clientY >= row.top && clientY < row.bottom);
  if (directHit) {
    return { track: directHit.track, trackIndex: directHit.trackIndex };
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  if (clientY < first.top) {
    return { track: first.track, trackIndex: first.trackIndex };
  }

  if (clientY >= last.bottom) {
    return { track: last.track, trackIndex: last.trackIndex };
  }

  let nearest = rows[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const center = (row.top + row.bottom) / 2;
    const distance = Math.abs(clientY - center);
    if (distance < nearestDistance) {
      nearest = row;
      nearestDistance = distance;
    }
  }

  return { track: nearest.track, trackIndex: nearest.trackIndex };
}

function resolveByFallbackIndex(
  sequence: Sequence,
  container: HTMLElement,
  clientY: number,
  scrollY: number,
  fallbackTrackHeight: number,
): TrackDropTarget | null {
  if (sequence.tracks.length === 0) return null;
  if (!isFiniteNumber(clientY) || !isFiniteNumber(scrollY)) return null;

  const rect = container.getBoundingClientRect();
  if (!isFiniteNumber(rect.top)) return null;

  const safeTrackHeight = fallbackTrackHeight > 0 ? fallbackTrackHeight : 64;
  const relativeY = clientY - rect.top + scrollY;
  const rawIndex = Math.floor(relativeY / safeTrackHeight);
  const trackIndex = Math.max(0, Math.min(rawIndex, sequence.tracks.length - 1));

  return {
    track: sequence.tracks[trackIndex],
    trackIndex,
  };
}

/**
 * Resolve a timeline track from a viewport Y coordinate.
 *
 * Priority:
 * 1) DOM row hit-test (`data-track-row` + `data-track-id`)
 * 2) Fallback index math using `fallbackTrackHeight`
 */
export function resolveTrackDropTarget({
  sequence,
  container,
  clientY,
  scrollY = 0,
  fallbackTrackHeight,
}: ResolveTrackDropTargetOptions): TrackDropTarget | null {
  if (!sequence || sequence.tracks.length === 0 || !container) {
    return null;
  }

  if (!isFiniteNumber(clientY)) {
    return null;
  }

  const domResolved = resolveByDomRows(sequence, container, clientY);
  if (domResolved) {
    return domResolved;
  }

  if (fallbackTrackHeight === undefined) {
    return null;
  }

  return resolveByFallbackIndex(sequence, container, clientY, scrollY, fallbackTrackHeight);
}

/**
 * Store Accessor for Agent Tools
 *
 * Provides read-only snapshots from Zustand stores for use by tool handlers
 * running outside React context. Analysis tools use this instead of IPC calls
 * to read timeline state that already exists in the frontend stores.
 *
 * Pattern reference: useAgenticLoopWithStores contextRefresher demonstrates
 * the same getState() approach for non-React access.
 */

import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Clip, Track, Sequence } from '@/types';

// =============================================================================
// Snapshot Types
// =============================================================================

export interface ClipSnapshot {
  id: string;
  assetId: string;
  trackId: string;
  timelineIn: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  speed: number;
  opacity: number;
  hasEffects: boolean;
  effectCount: number;
  label?: string;
}

export interface TrackSnapshot {
  id: string;
  name: string;
  kind: string;
  clipCount: number;
  muted: boolean;
  locked: boolean;
  visible: boolean;
  volume: number;
}

export interface TimelineSnapshot {
  sequenceId: string | null;
  sequenceName: string;
  duration: number;
  trackCount: number;
  clipCount: number;
  tracks: TrackSnapshot[];
  clips: ClipSnapshot[];
  selectedClipIds: string[];
  selectedTrackIds: string[];
  playheadPosition: number;
}

// =============================================================================
// Helpers
// =============================================================================

function clipToSnapshot(clip: Clip, trackId: string): ClipSnapshot {
  return {
    id: clip.id,
    assetId: clip.assetId,
    trackId,
    timelineIn: clip.place.timelineInSec,
    duration: clip.place.durationSec,
    sourceIn: clip.range.sourceInSec,
    sourceOut: clip.range.sourceOutSec,
    speed: clip.speed,
    opacity: clip.opacity,
    hasEffects: clip.effects.length > 0,
    effectCount: clip.effects.length,
    label: clip.label,
  };
}

function trackToSnapshot(track: Track): TrackSnapshot {
  return {
    id: track.id,
    name: track.name,
    kind: track.kind,
    clipCount: track.clips.length,
    muted: track.muted,
    locked: track.locked,
    visible: track.visible,
    volume: track.volume,
  };
}

function getActiveSequence(): Sequence | undefined {
  const project = useProjectStore.getState();
  if (!project.activeSequenceId) return undefined;
  return project.sequences.get(project.activeSequenceId);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Lightweight context for tool execution — avoids iterating all clips/tracks.
 * Returns only selectedClipIds, selectedTrackIds, playheadPosition, and sequenceId.
 */
export function getSelectionContext(): {
  sequenceId: string | null;
  selectedClipIds: string[];
  selectedTrackIds: string[];
  playheadPosition: number;
} {
  const project = useProjectStore.getState();
  const timeline = useTimelineStore.getState();
  const playback = usePlaybackStore.getState();

  return {
    sequenceId: project.activeSequenceId,
    selectedClipIds: timeline.selectedClipIds,
    selectedTrackIds: timeline.selectedTrackIds,
    playheadPosition: playback.currentTime,
  };
}

/**
 * Get a complete read-only snapshot of the current timeline state.
 * Reads from projectStore, timelineStore, and playbackStore.
 */
export function getTimelineSnapshot(): TimelineSnapshot {
  const playback = usePlaybackStore.getState();
  const timeline = useTimelineStore.getState();
  const project = useProjectStore.getState();

  const activeSequence = getActiveSequence();

  const tracks: TrackSnapshot[] = [];
  const clips: ClipSnapshot[] = [];

  if (activeSequence) {
    for (const track of activeSequence.tracks) {
      tracks.push(trackToSnapshot(track));
      for (const clip of track.clips) {
        clips.push(clipToSnapshot(clip, track.id));
      }
    }
  }

  return {
    sequenceId: project.activeSequenceId,
    sequenceName: activeSequence?.name ?? '',
    duration: playback.duration,
    trackCount: tracks.length,
    clipCount: clips.length,
    tracks,
    clips,
    selectedClipIds: timeline.selectedClipIds,
    selectedTrackIds: timeline.selectedTrackIds,
    playheadPosition: playback.currentTime,
  };
}

/**
 * Get a clip by ID across all tracks in the active sequence.
 */
export function getClipById(clipId: string): ClipSnapshot | null {
  const activeSequence = getActiveSequence();
  if (!activeSequence) return null;

  for (const track of activeSequence.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      return clipToSnapshot(clip, track.id);
    }
  }
  return null;
}

/**
 * Get a track by ID from the active sequence.
 */
export function getTrackById(trackId: string): TrackSnapshot | null {
  const activeSequence = getActiveSequence();
  if (!activeSequence) return null;

  const track = activeSequence.tracks.find((t) => t.id === trackId);
  return track ? trackToSnapshot(track) : null;
}

/**
 * Get all clips on a specific track.
 */
export function getAllClipsOnTrack(trackId: string): ClipSnapshot[] {
  const activeSequence = getActiveSequence();
  if (!activeSequence) return [];

  const track = activeSequence.tracks.find((t) => t.id === trackId);
  if (!track) return [];

  return track.clips.map((c) => clipToSnapshot(c, trackId));
}

/**
 * Get all clips at a specific time point across all tracks.
 */
export function getClipsAtTime(time: number): ClipSnapshot[] {
  const activeSequence = getActiveSequence();
  if (!activeSequence) return [];

  const result: ClipSnapshot[] = [];
  for (const track of activeSequence.tracks) {
    for (const clip of track.clips) {
      const clipStart = clip.place.timelineInSec;
      const clipEnd = clipStart + clip.place.durationSec;
      if (time >= clipStart && time < clipEnd) {
        result.push(clipToSnapshot(clip, track.id));
      }
    }
  }
  return result;
}

/**
 * Find all clips that reference a specific asset.
 */
export function findClipsByAsset(assetId: string): ClipSnapshot[] {
  const activeSequence = getActiveSequence();
  if (!activeSequence) return [];

  const result: ClipSnapshot[] = [];
  for (const track of activeSequence.tracks) {
    for (const clip of track.clips) {
      if (clip.assetId === assetId) {
        result.push(clipToSnapshot(clip, track.id));
      }
    }
  }
  return result;
}

/**
 * Find gaps (empty regions) between clips on a track or all tracks.
 * Only detects gaps between consecutive clips. Does not detect gaps at
 * the start of the track (before first clip) or at the end (after last
 * clip to timeline duration).
 */
export function findGaps(
  trackId?: string,
  minDuration: number = 0
): Array<{ trackId: string; startTime: number; endTime: number; duration: number }> {
  const activeSequence = getActiveSequence();
  if (!activeSequence) return [];

  const gaps: Array<{ trackId: string; startTime: number; endTime: number; duration: number }> = [];
  const tracksToSearch = trackId
    ? activeSequence.tracks.filter((t) => t.id === trackId)
    : activeSequence.tracks;

  for (const track of tracksToSearch) {
    // Sort clips by timeline position
    const sorted = [...track.clips].sort(
      (a, b) => a.place.timelineInSec - b.place.timelineInSec
    );

    if (sorted.length === 0) continue;
    let maxEndTime = sorted[0].place.timelineInSec + sorted[0].place.durationSec;

    for (let i = 1; i < sorted.length; i++) {
      const nextStart = sorted[i].place.timelineInSec;
      const gapDuration = nextStart - maxEndTime;

      if (gapDuration > 0 && gapDuration >= minDuration) {
        gaps.push({
          trackId: track.id,
          startTime: maxEndTime,
          endTime: nextStart,
          duration: gapDuration,
        });
      }
      maxEndTime = Math.max(maxEndTime, sorted[i].place.timelineInSec + sorted[i].place.durationSec);
    }
  }

  return gaps;
}

/**
 * Find overlapping clips on a track or all tracks.
 */
export function findOverlaps(
  trackId?: string
): Array<{
  trackId: string;
  clip1Id: string;
  clip2Id: string;
  overlapStart: number;
  overlapEnd: number;
  overlapDuration: number;
}> {
  const activeSequence = getActiveSequence();
  if (!activeSequence) return [];

  const overlaps: Array<{
    trackId: string;
    clip1Id: string;
    clip2Id: string;
    overlapStart: number;
    overlapEnd: number;
    overlapDuration: number;
  }> = [];

  const tracksToSearch = trackId
    ? activeSequence.tracks.filter((t) => t.id === trackId)
    : activeSequence.tracks;

  for (const track of tracksToSearch) {
    const sorted = [...track.clips].sort(
      (a, b) => a.place.timelineInSec - b.place.timelineInSec
    );

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const aStart = sorted[i].place.timelineInSec;
        const aEnd = aStart + sorted[i].place.durationSec;
        const bStart = sorted[j].place.timelineInSec;
        const bEnd = bStart + sorted[j].place.durationSec;

        const overlapStart = Math.max(aStart, bStart);
        const overlapEnd = Math.min(aEnd, bEnd);

        if (overlapStart < overlapEnd) {
          overlaps.push({
            trackId: track.id,
            clip1Id: sorted[i].id,
            clip2Id: sorted[j].id,
            overlapStart,
            overlapEnd,
            overlapDuration: overlapEnd - overlapStart,
          });
        }
      }
    }
  }

  return overlaps;
}

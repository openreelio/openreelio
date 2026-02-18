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
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { Asset, AssetKind, Clip, FileTreeEntry, Track, Sequence } from '@/types';

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
  stateVersion: number;
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

export interface AssetSnapshot {
  id: string;
  name: string;
  kind: Asset['kind'];
  uri: string;
  durationSec?: number;
  importedAt: string;
  proxyStatus: Asset['proxyStatus'];
  timelineClipCount: number;
  onTimeline: boolean;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  binId?: string | null;
}

export interface AssetCatalogSnapshot {
  stateVersion: number;
  totalAssetCount: number;
  videoAssetCount: number;
  audioAssetCount: number;
  imageAssetCount: number;
  unusedAssetCount: number;
  assets: AssetSnapshot[];
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

function buildAssetUsageCounts(activeSequence: Sequence | undefined): Map<string, number> {
  const usage = new Map<string, number>();
  if (!activeSequence) {
    return usage;
  }

  for (const track of activeSequence.tracks) {
    for (const clip of track.clips) {
      const current = usage.get(clip.assetId) ?? 0;
      usage.set(clip.assetId, current + 1);
    }
  }

  return usage;
}

function assetToSnapshot(asset: Asset, timelineClipCount: number): AssetSnapshot {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    uri: asset.uri,
    durationSec: asset.durationSec,
    importedAt: asset.importedAt,
    proxyStatus: asset.proxyStatus,
    timelineClipCount,
    onTimeline: timelineClipCount > 0,
    hasVideoStream: Boolean(asset.video),
    hasAudioStream: Boolean(asset.audio),
    binId: asset.binId,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Lightweight context for tool execution — avoids iterating all clips/tracks.
 * Returns only selectedClipIds, selectedTrackIds, playheadPosition, and sequenceId.
 */
export function getSelectionContext(): {
  stateVersion: number;
  sequenceId: string | null;
  selectedClipIds: string[];
  selectedTrackIds: string[];
  playheadPosition: number;
} {
  const project = useProjectStore.getState();
  const timeline = useTimelineStore.getState();
  const playback = usePlaybackStore.getState();

  return {
    stateVersion: project.stateVersion,
    sequenceId: project.activeSequenceId,
    selectedClipIds: timeline.selectedClipIds,
    selectedTrackIds: timeline.selectedTrackIds,
    playheadPosition: playback.currentTime,
  };
}

/**
 * Returns a snapshot of imported project assets along with timeline usage.
 * This enables source-aware workflows (finding imported media not yet on timeline).
 */
export function getAssetCatalogSnapshot(): AssetCatalogSnapshot {
  const project = useProjectStore.getState();
  const activeSequence = getActiveSequence();
  const usage = buildAssetUsageCounts(activeSequence);

  const assets = Array.from(project.assets.values())
    .map((asset) => assetToSnapshot(asset, usage.get(asset.id) ?? 0))
    .sort((left, right) => {
      if (left.onTimeline !== right.onTimeline) {
        return left.onTimeline ? 1 : -1;
      }

      return Date.parse(right.importedAt) - Date.parse(left.importedAt);
    });

  const videoAssetCount = assets.filter((asset) => asset.kind === 'video').length;
  const audioAssetCount = assets.filter((asset) => asset.kind === 'audio').length;
  const imageAssetCount = assets.filter((asset) => asset.kind === 'image').length;
  const unusedAssetCount = assets.filter((asset) => !asset.onTimeline).length;

  return {
    stateVersion: project.stateVersion,
    totalAssetCount: assets.length,
    videoAssetCount,
    audioAssetCount,
    imageAssetCount,
    unusedAssetCount,
    assets,
  };
}

/**
 * Returns a single asset snapshot by ID, including timeline usage metadata.
 */
export function getAssetSnapshotById(assetId: string): AssetSnapshot | null {
  const catalog = getAssetCatalogSnapshot();
  return catalog.assets.find((asset) => asset.id === assetId) ?? null;
}

/**
 * Returns imported assets that are currently unused on the active timeline.
 */
export function getUnusedAssets(kind?: AssetSnapshot['kind']): AssetSnapshot[] {
  const catalog = getAssetCatalogSnapshot();
  return catalog.assets.filter((asset) => !asset.onTimeline && (kind ? asset.kind === kind : true));
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
    stateVersion: project.stateVersion,
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
  minDuration: number = 0,
): Array<{ trackId: string; startTime: number; endTime: number; duration: number }> {
  const activeSequence = getActiveSequence();
  if (!activeSequence) return [];

  const gaps: Array<{ trackId: string; startTime: number; endTime: number; duration: number }> = [];
  const tracksToSearch = trackId
    ? activeSequence.tracks.filter((t) => t.id === trackId)
    : activeSequence.tracks;

  for (const track of tracksToSearch) {
    // Sort clips by timeline position
    const sorted = [...track.clips].sort((a, b) => a.place.timelineInSec - b.place.timelineInSec);

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
      maxEndTime = Math.max(
        maxEndTime,
        sorted[i].place.timelineInSec + sorted[i].place.durationSec,
      );
    }
  }

  return gaps;
}

/**
 * Find overlapping clips on a track or all tracks.
 */
export function findOverlaps(trackId?: string): Array<{
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
    const sorted = [...track.clips].sort((a, b) => a.place.timelineInSec - b.place.timelineInSec);

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

// =============================================================================
// Workspace Accessors
// =============================================================================

export interface WorkspaceFileSnapshot {
  relativePath: string;
  name: string;
  kind: AssetKind | undefined;
  fileSize: number | undefined;
  assetId: string | undefined;
  registered: boolean;
}

/**
 * Flatten workspace file tree into a flat list of leaf (non-directory) entries.
 */
function flattenFileTree(entries: FileTreeEntry[]): FileTreeEntry[] {
  const result: FileTreeEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      result.push(...flattenFileTree(entry.children));
    } else {
      result.push(entry);
    }
  }
  return result;
}

/**
 * Get all workspace files as a flat list of snapshots.
 * Optionally filter by asset kind.
 */
export function getWorkspaceFiles(kind?: AssetKind): WorkspaceFileSnapshot[] {
  const { fileTree } = useWorkspaceStore.getState();
  const flat = flattenFileTree(fileTree);

  return flat
    .filter((f) => (kind ? f.kind === kind : true))
    .map((f) => ({
      relativePath: f.relativePath,
      name: f.name,
      kind: f.kind,
      fileSize: f.fileSize,
      assetId: f.assetId,
      registered: f.assetId != null,
    }));
}

/**
 * Get workspace files that are NOT yet registered as project assets.
 */
export function getUnregisteredWorkspaceFiles(kind?: AssetKind): WorkspaceFileSnapshot[] {
  return getWorkspaceFiles(kind).filter((f) => !f.registered);
}

/**
 * Find workspace files by name (case-insensitive substring match).
 */
export function findWorkspaceFile(query: string): WorkspaceFileSnapshot[] {
  const lowerQuery = query.toLowerCase();
  return getWorkspaceFiles().filter(
    (f) =>
      f.name.toLowerCase().includes(lowerQuery) ||
      f.relativePath.toLowerCase().includes(lowerQuery),
  );
}

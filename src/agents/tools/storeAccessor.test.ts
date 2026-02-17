/**
 * Store Accessor Tests
 *
 * Tests for the store snapshot accessor used by analysis tools.
 * Verifies that tools correctly read from Zustand stores.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import {
  getSelectionContext,
  getAssetCatalogSnapshot,
  getAssetSnapshotById,
  getUnusedAssets,
  getTimelineSnapshot,
  getClipById,
  getTrackById,
  getAllClipsOnTrack,
  getClipsAtTime,
  findClipsByAsset,
  findGaps,
  findOverlaps,
} from './storeAccessor';
import type { Track, Clip, Asset } from '@/types';
import { createMockAsset, createMockClip, createMockTrack, createMockSequence } from '@/test/mocks';

// =============================================================================
// Test Helpers
// =============================================================================

function createClip(overrides: Partial<Clip> & { id: string; assetId: string }): Clip {
  return createMockClip(overrides);
}

function createTrack(overrides: Partial<Track> & { id: string }): Track {
  return createMockTrack({
    kind: 'video',
    name: `Track ${overrides.id}`,
    clips: [],
    ...overrides,
  });
}

function createAsset(overrides: Partial<Asset> & { id: string }): Asset {
  return createMockAsset(overrides);
}

function createSequence(tracks: Track[]) {
  return createMockSequence({
    id: 'seq_001',
    name: 'Test Sequence',
    tracks,
  });
}

function setupStores(options: {
  tracks?: Track[];
  selectedClipIds?: string[];
  selectedTrackIds?: string[];
  currentTime?: number;
  duration?: number;
}) {
  const tracks = options.tracks ?? [];
  const sequence = createSequence(tracks);

  // Set project store state
  useProjectStore.setState({
    activeSequenceId: 'seq_001',
    sequences: new Map([['seq_001', sequence]]),
    assets: new Map(),
    isLoaded: true,
  });

  // Set timeline store state
  useTimelineStore.setState({
    selectedClipIds: options.selectedClipIds ?? [],
    selectedTrackIds: options.selectedTrackIds ?? [],
  });

  // Set playback store state
  usePlaybackStore.setState({
    currentTime: options.currentTime ?? 0,
    duration: options.duration ?? 0,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('storeAccessor', () => {
  beforeEach(() => {
    useProjectStore.setState({
      activeSequenceId: null,
      sequences: new Map(),
      assets: new Map(),
    });
    useTimelineStore.setState({
      selectedClipIds: [],
      selectedTrackIds: [],
    });
    usePlaybackStore.setState({
      currentTime: 0,
      duration: 0,
    });
  });

  // ===========================================================================
  // Asset catalog helpers
  // ===========================================================================

  describe('asset catalog helpers', () => {
    it('should return imported assets with usage counts', () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset_video_used' });
      const clipB = createClip({ id: 'clipB', assetId: 'asset_video_used' });
      const clipC = createClip({ id: 'clipC', assetId: 'asset_audio_used' });

      const videoUsed = createAsset({
        id: 'asset_video_used',
        name: 'used-video.mp4',
        kind: 'video',
        importedAt: '2026-01-03T00:00:00.000Z',
      });
      const videoUnused = createAsset({
        id: 'asset_video_unused',
        name: 'unused-video.mp4',
        kind: 'video',
        importedAt: '2026-01-04T00:00:00.000Z',
      });
      const audioUsed = createAsset({
        id: 'asset_audio_used',
        name: 'used-audio.wav',
        kind: 'audio',
        importedAt: '2026-01-02T00:00:00.000Z',
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB, clipC] })],
      });

      useProjectStore.setState({
        assets: new Map([
          [videoUsed.id, videoUsed],
          [videoUnused.id, videoUnused],
          [audioUsed.id, audioUsed],
        ]),
      });

      const catalog = getAssetCatalogSnapshot();

      expect(catalog.totalAssetCount).toBe(3);
      expect(catalog.videoAssetCount).toBe(2);
      expect(catalog.audioAssetCount).toBe(1);
      expect(catalog.unusedAssetCount).toBe(1);

      const usedVideo = catalog.assets.find((asset) => asset.id === 'asset_video_used');
      const unusedVideo = catalog.assets.find((asset) => asset.id === 'asset_video_unused');
      expect(usedVideo?.timelineClipCount).toBe(2);
      expect(usedVideo?.onTimeline).toBe(true);
      expect(unusedVideo?.timelineClipCount).toBe(0);
      expect(unusedVideo?.onTimeline).toBe(false);
    });

    it('should return a single asset snapshot by id', () => {
      const asset = createAsset({ id: 'asset_1', name: 'clip.mp4', kind: 'video' });
      setupStores({ tracks: [] });
      useProjectStore.setState({ assets: new Map([[asset.id, asset]]) });

      const found = getAssetSnapshotById('asset_1');
      const missing = getAssetSnapshotById('missing_asset');

      expect(found).not.toBeNull();
      expect(found?.id).toBe('asset_1');
      expect(missing).toBeNull();
    });

    it('should return only unused assets and support kind filtering', () => {
      const usedVideo = createAsset({ id: 'video_used', kind: 'video' });
      const unusedVideo = createAsset({ id: 'video_unused', kind: 'video' });
      const unusedAudio = createAsset({ id: 'audio_unused', kind: 'audio' });

      const clipA = createClip({ id: 'clipA', assetId: usedVideo.id });
      setupStores({ tracks: [createTrack({ id: 'V1', clips: [clipA] })] });
      useProjectStore.setState({
        assets: new Map([
          [usedVideo.id, usedVideo],
          [unusedVideo.id, unusedVideo],
          [unusedAudio.id, unusedAudio],
        ]),
      });

      const allUnused = getUnusedAssets();
      const videoOnlyUnused = getUnusedAssets('video');

      expect(allUnused.map((asset) => asset.id).sort()).toEqual(['audio_unused', 'video_unused']);
      expect(videoOnlyUnused.map((asset) => asset.id)).toEqual(['video_unused']);
    });
  });

  // ===========================================================================
  // getTimelineSnapshot
  // ===========================================================================

  describe('getTimelineSnapshot', () => {
    it('should return empty snapshot when no active sequence', () => {
      const snapshot = getTimelineSnapshot();

      expect(snapshot.sequenceId).toBeNull();
      expect(snapshot.trackCount).toBe(0);
      expect(snapshot.clipCount).toBe(0);
      expect(snapshot.clips).toEqual([]);
      expect(snapshot.tracks).toEqual([]);
    });

    it('should return timeline state with 2 tracks and 3 clips', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 5 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 5, durationSec: 5 },
      });
      const clipC = createClip({
        id: 'clipC',
        assetId: 'asset2',
        place: { timelineInSec: 0, durationSec: 10 },
      });

      setupStores({
        tracks: [
          createTrack({ id: 'V1', clips: [clipA, clipB] }),
          createTrack({ id: 'A1', kind: 'audio', clips: [clipC] }),
        ],
        duration: 10,
      });

      const snapshot = getTimelineSnapshot();

      expect(snapshot.sequenceId).toBe('seq_001');
      expect(snapshot.trackCount).toBe(2);
      expect(snapshot.clipCount).toBe(3);
      expect(snapshot.duration).toBe(10);
    });

    it('should include selected clips and playhead position', () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1' });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA] })],
        selectedClipIds: ['clipA'],
        selectedTrackIds: ['V1'],
        currentTime: 3.5,
        duration: 10,
      });

      const snapshot = getTimelineSnapshot();

      expect(snapshot.selectedClipIds).toEqual(['clipA']);
      expect(snapshot.selectedTrackIds).toEqual(['V1']);
      expect(snapshot.playheadPosition).toBe(3.5);
    });
  });

  // ===========================================================================
  // getSelectionContext
  // ===========================================================================

  describe('getSelectionContext', () => {
    it('should return lightweight context without iterating clips/tracks', () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1' });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA] })],
        selectedClipIds: ['clipA'],
        selectedTrackIds: ['V1'],
        currentTime: 7.5,
      });

      const ctx = getSelectionContext();
      expect(ctx.sequenceId).toBe('seq_001');
      expect(ctx.selectedClipIds).toEqual(['clipA']);
      expect(ctx.selectedTrackIds).toEqual(['V1']);
      expect(ctx.playheadPosition).toBe(7.5);
    });
  });

  // ===========================================================================
  // getClipById
  // ===========================================================================

  describe('getClipById', () => {
    it('should return null when no active sequence', () => {
      expect(getClipById('any')).toBeNull();
    });

    it('should find clip across tracks', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 5 },
        range: { sourceInSec: 0, sourceOutSec: 5 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA] })],
      });

      const result = getClipById('clipA');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('clipA');
      expect(result!.trackId).toBe('V1');
      expect(result!.timelineIn).toBe(0);
      expect(result!.duration).toBe(5);
    });

    it('should return null for non-existent clip', () => {
      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [] })],
      });

      expect(getClipById('nonexistent')).toBeNull();
    });
  });

  // ===========================================================================
  // getTrackById
  // ===========================================================================

  describe('getTrackById', () => {
    it('should return null when no active sequence', () => {
      expect(getTrackById('any')).toBeNull();
    });

    it('should find track by id', () => {
      setupStores({
        tracks: [
          createTrack({ id: 'V1', name: 'Video 1', kind: 'video' }),
          createTrack({ id: 'A1', name: 'Audio 1', kind: 'audio' }),
        ],
      });

      const result = getTrackById('A1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('A1');
      expect(result!.name).toBe('Audio 1');
      expect(result!.kind).toBe('audio');
    });

    it('should return null for non-existent track', () => {
      setupStores({ tracks: [createTrack({ id: 'V1' })] });
      expect(getTrackById('nonexistent')).toBeNull();
    });
  });

  // ===========================================================================
  // getAllClipsOnTrack
  // ===========================================================================

  describe('getAllClipsOnTrack', () => {
    it('should return all clips on the specified track', () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1' });
      const clipB = createClip({ id: 'clipB', assetId: 'asset2' });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
      });

      const clips = getAllClipsOnTrack('V1');
      expect(clips).toHaveLength(2);
      expect(clips.map((c) => c.id)).toEqual(['clipA', 'clipB']);
    });

    it('should return empty array for non-existent track', () => {
      setupStores({ tracks: [] });
      expect(getAllClipsOnTrack('nonexistent')).toEqual([]);
    });
  });

  // ===========================================================================
  // getClipsAtTime
  // ===========================================================================

  describe('getClipsAtTime', () => {
    it('should find clips spanning the given time', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 5 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset2',
        place: { timelineInSec: 3, durationSec: 5 },
      });

      setupStores({
        tracks: [
          createTrack({ id: 'V1', clips: [clipA] }),
          createTrack({ id: 'V2', clips: [clipB] }),
        ],
      });

      // At time=4, both clips are active
      const result = getClipsAtTime(4);
      expect(result).toHaveLength(2);
      expect(result.map((c) => c.id).sort()).toEqual(['clipA', 'clipB']);
    });

    it('should return empty for time with no clips', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 3 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA] })],
      });

      // At time=5, no clips
      expect(getClipsAtTime(5)).toEqual([]);
    });

    it('should not include clip at its exact end time', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 5 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA] })],
      });

      // At exactly time=5 (end of clip), clip should not be included
      expect(getClipsAtTime(5)).toEqual([]);
      // But at time=0 (start), it should be included
      expect(getClipsAtTime(0)).toHaveLength(1);
    });
  });

  // ===========================================================================
  // findClipsByAsset
  // ===========================================================================

  describe('findClipsByAsset', () => {
    it('should find all clips using a specific asset', () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1' });
      const clipB = createClip({ id: 'clipB', assetId: 'asset2' });
      const clipC = createClip({ id: 'clipC', assetId: 'asset1' });

      setupStores({
        tracks: [
          createTrack({ id: 'V1', clips: [clipA, clipB] }),
          createTrack({ id: 'V2', clips: [clipC] }),
        ],
      });

      const result = findClipsByAsset('asset1');
      expect(result).toHaveLength(2);
      expect(result.map((c) => c.id).sort()).toEqual(['clipA', 'clipC']);
    });

    it('should return empty when no clips use the asset', () => {
      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [] })],
      });

      expect(findClipsByAsset('nonexistent')).toEqual([]);
    });
  });

  // ===========================================================================
  // findGaps
  // ===========================================================================

  describe('findGaps', () => {
    it('should detect gaps between clips on a track', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 3 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 5, durationSec: 5 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
      });

      const gaps = findGaps();
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toEqual({
        trackId: 'V1',
        startTime: 3,
        endTime: 5,
        duration: 2,
      });
    });

    it('should detect no gaps when clips are contiguous', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 5 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 5, durationSec: 5 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
      });

      const gaps = findGaps();
      expect(gaps).toEqual([]);
    });

    it('should filter gaps by minimum duration', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 3 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 5, durationSec: 5 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
      });

      // minDuration=3 should exclude the 2s gap
      expect(findGaps(undefined, 3)).toEqual([]);
      // minDuration=1 should include it
      expect(findGaps(undefined, 1)).toHaveLength(1);
    });

    it('should include gap that exactly equals minDuration', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 3 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 5, durationSec: 5 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
      });

      // Gap is exactly 2s, minDuration=2 should include it (>= semantics)
      const gaps = findGaps(undefined, 2);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].duration).toBe(2);
    });

    it('should search specific track when trackId provided', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 3 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 5, durationSec: 5 },
      });

      setupStores({
        tracks: [
          createTrack({ id: 'V1', clips: [clipA, clipB] }),
          createTrack({ id: 'V2', clips: [] }),
        ],
      });

      expect(findGaps('V1')).toHaveLength(1);
      expect(findGaps('V2')).toEqual([]);
    });

    it('should not report false gaps when clips overlap', () => {
      // Clip A spans 0-10s, clip B is nested within (3-8s), clip C starts at 12s
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 3, durationSec: 5 },
      });
      const clipC = createClip({
        id: 'clipC',
        assetId: 'asset1',
        place: { timelineInSec: 12, durationSec: 3 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB, clipC] })],
      });

      // Only one real gap: 10-12s (between clipA end and clipC start)
      // clipB is nested in clipA so should not create a false gap at 8s
      const gaps = findGaps();
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toEqual({
        trackId: 'V1',
        startTime: 10,
        endTime: 12,
        duration: 2,
      });
    });
  });

  // ===========================================================================
  // findOverlaps
  // ===========================================================================

  describe('findOverlaps', () => {
    it('should detect overlapping clips on the same track', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 5 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 3, durationSec: 5 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
      });

      const overlaps = findOverlaps();
      expect(overlaps).toHaveLength(1);
      expect(overlaps[0]).toEqual({
        trackId: 'V1',
        clip1Id: 'clipA',
        clip2Id: 'clipB',
        overlapStart: 3,
        overlapEnd: 5,
        overlapDuration: 2,
      });
    });

    it('should return empty when no overlaps exist', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 3 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 5, durationSec: 5 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
      });

      expect(findOverlaps()).toEqual([]);
    });

    it('should not detect overlaps across different tracks', () => {
      const clipA = createClip({
        id: 'clipA',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const clipB = createClip({
        id: 'clipB',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 10 },
      });

      setupStores({
        tracks: [
          createTrack({ id: 'V1', clips: [clipA] }),
          createTrack({ id: 'V2', clips: [clipB] }),
        ],
      });

      // Clips overlap in time but on different tracks - no overlap reported
      expect(findOverlaps()).toEqual([]);
    });
  });
});

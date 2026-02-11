/**
 * Analysis Tools Tests
 *
 * BDD tests for timeline analysis tools.
 * Tools now read from Zustand stores instead of calling backend IPC.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { globalToolRegistry, type ToolExecutionResult } from '../ToolRegistry';
import {
  registerAnalysisTools,
  unregisterAnalysisTools,
  getAnalysisToolNames,
} from './analysisTools';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Track, Clip } from '@/types';
import {
  createMockClip,
  createMockTrack,
  createMockSequence,
} from '@/test/mocks';

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

function setupStores(options: {
  tracks?: Track[];
  selectedClipIds?: string[];
  selectedTrackIds?: string[];
  currentTime?: number;
  duration?: number;
}) {
  const tracks = options.tracks ?? [];
  const sequence = createMockSequence({
    id: 'seq_001',
    name: 'Test Sequence',
    tracks,
  });

  useProjectStore.setState({
    activeSequenceId: 'seq_001',
    sequences: new Map([['seq_001', sequence]]),
    assets: new Map(),
    isLoaded: true,
  });

  useTimelineStore.setState({
    selectedClipIds: options.selectedClipIds ?? [],
    selectedTrackIds: options.selectedTrackIds ?? [],
  });

  usePlaybackStore.setState({
    currentTime: options.currentTime ?? 0,
    duration: options.duration ?? 0,
  });
}

function expectToolSuccess<T>(
  result: ToolExecutionResult
): asserts result is ToolExecutionResult & { success: true; result: T } {
  expect(result.success).toBe(true);
  expect(result.result).not.toBeUndefined();
}

function getToolResult<T>(result: ToolExecutionResult): T {
  expectToolSuccess<T>(result);
  return result.result;
}

// =============================================================================
// Tests
// =============================================================================

describe('analysisTools', () => {
  beforeEach(() => {
    globalToolRegistry.clear();
    registerAnalysisTools();

    // Reset stores
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

  afterEach(() => {
    unregisterAnalysisTools();
  });

  // ===========================================================================
  // Registration
  // ===========================================================================

  describe('registration', () => {
    it('should register all analysis tools', () => {
      expect(globalToolRegistry.has('get_timeline_info')).toBe(true);
      expect(globalToolRegistry.has('find_clips_by_asset')).toBe(true);
      expect(globalToolRegistry.has('find_gaps')).toBe(true);
      expect(globalToolRegistry.has('find_overlaps')).toBe(true);
      expect(globalToolRegistry.has('get_clip_info')).toBe(true);
      expect(globalToolRegistry.has('list_all_clips')).toBe(true);
      expect(globalToolRegistry.has('list_tracks')).toBe(true);
      expect(globalToolRegistry.has('get_clips_at_time')).toBe(true);
      expect(globalToolRegistry.has('get_selected_clips')).toBe(true);
      expect(globalToolRegistry.has('get_playhead_position')).toBe(true);
      expect(globalToolRegistry.has('get_track_clips')).toBe(true);
    });

    it('should register tools in analysis category', () => {
      const analysisTools = globalToolRegistry.listByCategory('analysis');
      expect(analysisTools.length).toBe(11);
    });

    it('should return correct tool names', () => {
      const names = getAnalysisToolNames();
      expect(names).toContain('get_timeline_info');
      expect(names).toContain('list_all_clips');
      expect(names).toContain('get_playhead_position');
      expect(names).toHaveLength(11);
    });

    it('should unregister all tools', () => {
      unregisterAnalysisTools();
      expect(globalToolRegistry.has('get_timeline_info')).toBe(false);
      expect(globalToolRegistry.has('list_all_clips')).toBe(false);
      expect(globalToolRegistry.has('get_playhead_position')).toBe(false);
    });
  });

  // ===========================================================================
  // get_timeline_info: returns current timeline state
  // ===========================================================================

  describe('get_timeline_info', () => {
    it('should return timeline state with 2 tracks and 3 clips', async () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1', place: { timelineInSec: 0, durationSec: 5 } });
      const clipB = createClip({ id: 'clipB', assetId: 'asset1', place: { timelineInSec: 5, durationSec: 5 } });
      const clipC = createClip({ id: 'clipC', assetId: 'asset2', place: { timelineInSec: 0, durationSec: 10 } });

      setupStores({
        tracks: [
          createTrack({ id: 'V1', clips: [clipA, clipB] }),
          createTrack({ id: 'A1', kind: 'audio', clips: [clipC] }),
        ],
        duration: 10,
      });

      const result = await globalToolRegistry.execute('get_timeline_info', {});
      const info = getToolResult<{
        sequenceId: string | null;
        trackCount: number;
        clipCount: number;
        duration: number;
      }>(result);
      expect(info.sequenceId).toBe('seq_001');
      expect(info.trackCount).toBe(2);
      expect(info.clipCount).toBe(3);
      expect(info.duration).toBe(10);
    });

    it('should return empty state when no active sequence', async () => {
      const result = await globalToolRegistry.execute('get_timeline_info', {});
      const info = getToolResult<{
        sequenceId: string | null;
        trackCount: number;
        clipCount: number;
      }>(result);
      expect(info.sequenceId).toBeNull();
      expect(info.trackCount).toBe(0);
      expect(info.clipCount).toBe(0);
    });
  });

  // ===========================================================================
  // list_all_clips: returns all clips with positions
  // ===========================================================================

  describe('list_all_clips', () => {
    it('should return all clips across all tracks', async () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1', place: { timelineInSec: 0, durationSec: 5 } });
      const clipB = createClip({ id: 'clipB', assetId: 'asset1', place: { timelineInSec: 5, durationSec: 5 } });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
      });

      const result = await globalToolRegistry.execute('list_all_clips', {});
      const clips = getToolResult<
        Array<{ id: string; trackId: string; timelineIn: number; duration: number }>
      >(result);
      expect(clips).toHaveLength(2);
      expect(clips[0].id).toBe('clipA');
      expect(clips[0].trackId).toBe('V1');
      expect(clips[0].timelineIn).toBe(0);
      expect(clips[0].duration).toBe(5);
      expect(clips[1].id).toBe('clipB');
      expect(clips[1].timelineIn).toBe(5);
    });
  });

  // ===========================================================================
  // list_tracks: returns all tracks with clip counts
  // ===========================================================================

  describe('list_tracks', () => {
    it('should return all tracks with their info', async () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1' });

      setupStores({
        tracks: [
          createTrack({ id: 'V1', name: 'Video 1', clips: [clipA] }),
          createTrack({ id: 'A1', name: 'Audio 1', kind: 'audio', clips: [] }),
        ],
      });

      const result = await globalToolRegistry.execute('list_tracks', {});
      const tracks = getToolResult<
        Array<{ id: string; kind: string; clipCount: number }>
      >(result);
      expect(tracks).toHaveLength(2);
      expect(tracks[0].id).toBe('V1');
      expect(tracks[0].clipCount).toBe(1);
      expect(tracks[1].id).toBe('A1');
      expect(tracks[1].kind).toBe('audio');
      expect(tracks[1].clipCount).toBe(0);
    });
  });

  // ===========================================================================
  // find_clips_by_asset: finds clips using a specific asset
  // ===========================================================================

  describe('find_clips_by_asset', () => {
    it('should find clips using specific asset', async () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset_001' });
      const clipB = createClip({ id: 'clipB', assetId: 'asset_002' });
      const clipC = createClip({ id: 'clipC', assetId: 'asset_001' });

      setupStores({
        tracks: [
          createTrack({ id: 'V1', clips: [clipA, clipB] }),
          createTrack({ id: 'V2', clips: [clipC] }),
        ],
      });

      const result = await globalToolRegistry.execute('find_clips_by_asset', {
        assetId: 'asset_001',
      });
      const clips = getToolResult<Array<{ id: string }>>(result);
      expect(clips).toHaveLength(2);
    });

    it('should return empty array when no clips found', async () => {
      setupStores({ tracks: [createTrack({ id: 'V1' })] });

      const result = await globalToolRegistry.execute('find_clips_by_asset', {
        assetId: 'nonexistent_asset',
      });
      const clips = getToolResult<Array<{ id: string }>>(result);
      expect(clips).toEqual([]);
    });
  });

  // ===========================================================================
  // find_gaps: detects empty timeline regions
  // ===========================================================================

  describe('find_gaps', () => {
    it('should detect gap between clips', async () => {
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

      const result = await globalToolRegistry.execute('find_gaps', {});
      const gaps = getToolResult<Array<{
        trackId: string;
        startTime: number;
        endTime: number;
        duration: number;
      }>>(result);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toEqual({
        trackId: 'V1',
        startTime: 3,
        endTime: 5,
        duration: 2,
      });
    });

    it('should find gaps on specific track', async () => {
      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [] })],
      });

      const result = await globalToolRegistry.execute('find_gaps', {
        trackId: 'V1',
      });
      const gaps = getToolResult<Array<{ trackId: string }>>(result);
      expect(gaps).toEqual([]);
    });

    it('should filter gaps by minimum duration', async () => {
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

      const result = await globalToolRegistry.execute('find_gaps', {
        minDuration: 3.0,
      });
      const gaps = getToolResult<Array<{ trackId: string }>>(result);
      expect(gaps).toEqual([]);
    });

    it('should include gap that exactly equals minDuration', async () => {
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

      // Gap is exactly 2s; minDuration=2 should include it (>= semantics)
      const result = await globalToolRegistry.execute('find_gaps', {
        minDuration: 2.0,
      });
      const gaps = getToolResult<Array<{ duration: number }>>(result);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].duration).toBe(2);
    });
  });

  // ===========================================================================
  // find_overlaps: detects overlapping clips
  // ===========================================================================

  describe('find_overlaps', () => {
    it('should find overlapping clips', async () => {
      const clipA = createClip({
        id: 'clip_001',
        assetId: 'asset1',
        place: { timelineInSec: 0, durationSec: 10 },
      });
      const clipB = createClip({
        id: 'clip_002',
        assetId: 'asset1',
        place: { timelineInSec: 8, durationSec: 4 },
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
      });

      const result = await globalToolRegistry.execute('find_overlaps', {});
      const overlaps = getToolResult<Array<{ overlapDuration: number }>>(result);
      expect(overlaps).toHaveLength(1);
      expect(overlaps[0].overlapDuration).toBe(2);
    });

    it('should find overlaps on specific track', async () => {
      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [] })],
      });

      const result = await globalToolRegistry.execute('find_overlaps', {
        trackId: 'V1',
      });
      const overlaps = getToolResult<Array<{ overlapDuration: number }>>(result);
      expect(overlaps).toEqual([]);
    });
  });

  // ===========================================================================
  // get_clip_info: returns clip details
  // ===========================================================================

  describe('get_clip_info', () => {
    it('should return detailed clip information', async () => {
      const clipA = createClip({
        id: 'clip_001',
        assetId: 'asset_001',
        place: { timelineInSec: 0, durationSec: 10 },
        range: { sourceInSec: 0, sourceOutSec: 10 },
        effects: ['fx1', 'fx2', 'fx3'],
      });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA] })],
      });

      const result = await globalToolRegistry.execute('get_clip_info', {
        clipId: 'clip_001',
      });
      const clip = getToolResult<{
        id: string;
        assetId: string;
        trackId: string;
        hasEffects: boolean;
        effectCount: number;
      }>(result);
      expect(clip.id).toBe('clip_001');
      expect(clip.assetId).toBe('asset_001');
      expect(clip.trackId).toBe('V1');
      expect(clip.hasEffects).toBe(true);
      expect(clip.effectCount).toBe(3);
    });

    it('should return error for non-existent clip', async () => {
      setupStores({ tracks: [createTrack({ id: 'V1' })] });

      const result = await globalToolRegistry.execute('get_clip_info', {
        clipId: 'nonexistent_clip',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ===========================================================================
  // get_clips_at_time: finds clips at a specific time
  // ===========================================================================

  describe('get_clips_at_time', () => {
    it('should find clips at playhead time', async () => {
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

      const result = await globalToolRegistry.execute('get_clips_at_time', {
        time: 4,
      });
      const clips = getToolResult<Array<{ id: string }>>(result);
      expect(clips).toHaveLength(2);
    });

    it('should return empty when no clips at time', async () => {
      setupStores({ tracks: [createTrack({ id: 'V1' })] });

      const result = await globalToolRegistry.execute('get_clips_at_time', {
        time: 10,
      });
      const clips = getToolResult<Array<{ id: string }>>(result);
      expect(clips).toEqual([]);
    });
  });

  // ===========================================================================
  // get_selected_clips: returns selected clip details
  // ===========================================================================

  describe('get_selected_clips', () => {
    it('should return details of selected clips', async () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1' });
      const clipB = createClip({ id: 'clipB', assetId: 'asset2' });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
        selectedClipIds: ['clipA', 'clipB'],
      });

      const result = await globalToolRegistry.execute('get_selected_clips', {});
      const clips = getToolResult<Array<{ id: string }>>(result);
      expect(clips).toHaveLength(2);
      expect(clips.map((c) => c.id).sort()).toEqual(['clipA', 'clipB']);
    });

    it('should return empty when no clips selected', async () => {
      setupStores({ tracks: [createTrack({ id: 'V1' })] });

      const result = await globalToolRegistry.execute('get_selected_clips', {});
      const clips = getToolResult<Array<{ id: string }>>(result);
      expect(clips).toEqual([]);
    });

    it('should gracefully skip stale/orphan selected clip IDs', async () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1' });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA] })],
        selectedClipIds: ['clipA', 'deleted_clip_id'],
      });

      const result = await globalToolRegistry.execute('get_selected_clips', {});
      const clips = getToolResult<Array<{ id: string }>>(result);
      // Only clipA exists; deleted_clip_id should be silently excluded
      expect(clips).toHaveLength(1);
      expect(clips[0].id).toBe('clipA');
    });
  });

  // ===========================================================================
  // get_playhead_position: returns current playhead time
  // ===========================================================================

  describe('get_playhead_position', () => {
    it('should return current playhead position', async () => {
      setupStores({
        tracks: [createTrack({ id: 'V1' })],
        currentTime: 7.5,
        duration: 30,
      });

      const result = await globalToolRegistry.execute('get_playhead_position', {});
      const playhead = getToolResult<{ position: number; duration: number }>(result);
      expect(playhead.position).toBe(7.5);
      expect(playhead.duration).toBe(30);
    });
  });

  // ===========================================================================
  // get_track_clips: returns clips on a specific track
  // ===========================================================================

  describe('get_track_clips', () => {
    it('should return track info and clips', async () => {
      const clipA = createClip({ id: 'clipA', assetId: 'asset1' });
      const clipB = createClip({ id: 'clipB', assetId: 'asset2' });

      setupStores({
        tracks: [createTrack({ id: 'V1', name: 'Video 1', clips: [clipA, clipB] })],
      });

      const result = await globalToolRegistry.execute('get_track_clips', {
        trackId: 'V1',
      });
      const trackClips = getToolResult<{
        track: { id: string };
        clips: Array<{ id: string }>;
      }>(result);
      expect(trackClips.track.id).toBe('V1');
      expect(trackClips.clips).toHaveLength(2);
    });

    it('should return error for non-existent track', async () => {
      setupStores({ tracks: [] });

      const result = await globalToolRegistry.execute('get_track_clips', {
        trackId: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});

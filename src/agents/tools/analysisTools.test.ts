/**
 * Analysis Tools Tests
 *
 * BDD tests for timeline analysis tools.
 * Tools now read from Zustand stores instead of calling backend IPC.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { globalToolRegistry, type ToolExecutionResult } from '../ToolRegistry';
import {
  registerAnalysisTools,
  unregisterAnalysisTools,
  getAnalysisToolNames,
} from './analysisTools';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Track, Clip, Asset, Sequence } from '@/types';
import { createMockAsset, createMockClip, createMockTrack, createMockSequence } from '@/test/mocks';
import { invoke } from '@tauri-apps/api/core';

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

function setupStores(options: {
  tracks?: Track[];
  sequences?: Sequence[];
  activeSequenceId?: string | null;
  assets?: Asset[];
  selectedClipIds?: string[];
  selectedTrackIds?: string[];
  currentTime?: number;
  duration?: number;
}) {
  const tracks = options.tracks ?? [];
  const assets = options.assets ?? [];
  const defaultSequence = createMockSequence({
    id: 'seq_001',
    name: 'Test Sequence',
    tracks,
  });
  const sequences = options.sequences ?? [defaultSequence];
  const activeSequenceId =
    options.activeSequenceId === undefined ? 'seq_001' : options.activeSequenceId;

  useProjectStore.setState({
    activeSequenceId,
    sequences: new Map(sequences.map((sequence) => [sequence.id, sequence])),
    assets: new Map(assets.map((asset) => [asset.id, asset])),
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
  result: ToolExecutionResult,
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
    vi.clearAllMocks();
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
      expect(globalToolRegistry.has('get_asset_catalog')).toBe(true);
      expect(globalToolRegistry.has('get_unused_assets')).toBe(true);
      expect(globalToolRegistry.has('get_asset_info')).toBe(true);
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
      expect(analysisTools.length).toBe(24);
    });

    it('should return correct tool names', () => {
      const names = getAnalysisToolNames();
      expect(names).toContain('get_asset_catalog');
      expect(names).toContain('get_unused_assets');
      expect(names).toContain('get_asset_info');
      expect(names).toContain('get_timeline_info');
      expect(names).toContain('list_all_clips');
      expect(names).toContain('get_playhead_position');
      expect(names).toContain('get_workspace_files');
      expect(names).toContain('find_workspace_file');
      expect(names).toContain('get_unregistered_files');
      expect(names).toContain('generate_source_analysis_report');
      expect(names).toContain('search_source_analysis_report');
      expect(names).toContain('search_source_library');
      expect(names).toContain('build_source_selects');
      expect(names).toHaveLength(24);
    });

    it('should unregister all tools', () => {
      unregisterAnalysisTools();
      expect(globalToolRegistry.has('get_asset_catalog')).toBe(false);
      expect(globalToolRegistry.has('get_timeline_info')).toBe(false);
      expect(globalToolRegistry.has('list_all_clips')).toBe(false);
      expect(globalToolRegistry.has('get_playhead_position')).toBe(false);
    });
  });

  // ===========================================================================
  // Asset source-discovery tools
  // ===========================================================================

  describe('asset source-discovery tools', () => {
    it('get_asset_catalog should include timeline usage and counts', async () => {
      const clipA = createClip({ id: 'clipA', assetId: 'video_used' });
      const clipB = createClip({ id: 'clipB', assetId: 'video_used' });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA, clipB] })],
        assets: [
          createAsset({ id: 'video_used', kind: 'video', importedAt: '2026-01-01T00:00:00.000Z' }),
          createAsset({
            id: 'video_unused',
            kind: 'video',
            importedAt: '2026-01-02T00:00:00.000Z',
          }),
          createAsset({
            id: 'audio_unused',
            kind: 'audio',
            importedAt: '2026-01-03T00:00:00.000Z',
          }),
        ],
      });

      const result = await globalToolRegistry.execute('get_asset_catalog', {});
      const catalog = getToolResult<{
        totalAssetCount: number;
        unusedAssetCount: number;
        assets: Array<{ id: string; timelineClipCount: number; onTimeline: boolean }>;
      }>(result);

      expect(catalog.totalAssetCount).toBe(3);
      expect(catalog.unusedAssetCount).toBe(2);

      const used = catalog.assets.find((asset) => asset.id === 'video_used');
      expect(used?.timelineClipCount).toBe(2);
      expect(used?.onTimeline).toBe(true);
    });

    it('get_asset_catalog should count asset usage across all sequences', async () => {
      const activeSequence = createMockSequence({
        id: 'seq_001',
        name: 'Active Sequence',
        tracks: [createTrack({ id: 'V1', clips: [] })],
      });
      const secondarySequence = createMockSequence({
        id: 'seq_002',
        name: 'Secondary Sequence',
        tracks: [
          createTrack({
            id: 'V2',
            clips: [createClip({ id: 'clipOther', assetId: 'video_elsewhere' })],
          }),
        ],
      });

      setupStores({
        sequences: [activeSequence, secondarySequence],
        activeSequenceId: 'seq_001',
        assets: [createAsset({ id: 'video_elsewhere', kind: 'video' })],
      });

      const result = await globalToolRegistry.execute('get_asset_catalog', {});
      const catalog = getToolResult<{
        assets: Array<{ id: string; timelineClipCount: number; onTimeline: boolean }>;
      }>(result);

      expect(catalog.assets[0]?.id).toBe('video_elsewhere');
      expect(catalog.assets[0]?.timelineClipCount).toBe(1);
      expect(catalog.assets[0]?.onTimeline).toBe(true);
    });

    it('get_unused_assets should filter by kind when provided', async () => {
      const clipA = createClip({ id: 'clipA', assetId: 'video_used' });

      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [clipA] })],
        assets: [
          createAsset({ id: 'video_used', kind: 'video' }),
          createAsset({ id: 'video_unused', kind: 'video' }),
          createAsset({ id: 'audio_unused', kind: 'audio' }),
        ],
      });

      const allResult = await globalToolRegistry.execute('get_unused_assets', {});
      const allUnused = getToolResult<Array<{ id: string }>>(allResult);
      expect(allUnused.map((asset) => asset.id).sort()).toEqual(['audio_unused', 'video_unused']);

      const filteredResult = await globalToolRegistry.execute('get_unused_assets', {
        kind: 'video',
      });
      const videoOnly = getToolResult<Array<{ id: string }>>(filteredResult);
      expect(videoOnly.map((asset) => asset.id)).toEqual(['video_unused']);
    });

    it('get_asset_info should return asset details and fail for missing asset', async () => {
      setupStores({
        tracks: [],
        assets: [createAsset({ id: 'asset_1', name: 'broll.mp4', kind: 'video' })],
      });

      const result = await globalToolRegistry.execute('get_asset_info', { assetId: 'asset_1' });
      const asset = getToolResult<{ id: string; name: string }>(result);
      expect(asset.id).toBe('asset_1');
      expect(asset.name).toBe('broll.mp4');

      const missingResult = await globalToolRegistry.execute('get_asset_info', {
        assetId: 'missing_asset',
      });
      expect(missingResult.success).toBe(false);
      expect(missingResult.error).toContain('not found');
    });
  });

  // ===========================================================================
  // get_timeline_info: returns current timeline state
  // ===========================================================================

  describe('get_timeline_info', () => {
    it('should return timeline state with 2 tracks and 3 clips', async () => {
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

      const result = await globalToolRegistry.execute('list_all_clips', {});
      const clips =
        getToolResult<Array<{ id: string; trackId: string; timelineIn: number; duration: number }>>(
          result,
        );
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
      const tracks = getToolResult<Array<{ id: string; kind: string; clipCount: number }>>(result);
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
      const gaps = getToolResult<
        Array<{
          trackId: string;
          startTime: number;
          endTime: number;
          duration: number;
        }>
      >(result);
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

// =============================================================================
// Reference Style Transfer Analysis Tools
// =============================================================================

describe('reference style transfer analysis tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  // analyze_reference_video
  // ===========================================================================

  describe('analyze_reference_video', () => {
    it('should return analysis summary when given valid assetId', async () => {
      const mockBundle = {
        assetId: 'ref-1',
        shots: [
          { startSec: 0, endSec: 2, confidence: 0.9 },
          { startSec: 2, endSec: 5, confidence: 0.85 },
        ],
        transcript: null,
        audioProfile: { tempo: 120, loudnessLufs: -14, dynamicRange: 12 },
        segments: [{ segmentType: 'talk', startSec: 0, endSec: 5 }],
        frameAnalysis: null,
        metadata: { durationSec: 10, width: 1920, height: 1080, fps: 30 },
        analyzedAt: '2026-03-07T00:00:00Z',
        errors: {},
      };
      vi.mocked(invoke).mockResolvedValue(mockBundle);

      const result = await globalToolRegistry.execute('analyze_reference_video', {
        assetId: 'ref-1',
      });
      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({
        assetId: 'ref-1',
        shotCount: 2,
        segmentCount: 1,
        hasAudioProfile: true,
        hasTranscript: false,
      });
    });

    it('should fail when assetId is missing', async () => {
      const result = await globalToolRegistry.execute('analyze_reference_video', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('assetId');
    });

    it('should handle IPC error gracefully', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Asset not found'));
      const result = await globalToolRegistry.execute('analyze_reference_video', {
        assetId: 'bad-id',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Asset not found');
    });

    it('should pass analysis options to IPC', async () => {
      const mockBundle = {
        assetId: 'ref-1',
        shots: [],
        transcript: null,
        audioProfile: null,
        segments: null,
        frameAnalysis: null,
        metadata: { durationSec: 5, width: 1280, height: 720, fps: 24 },
        analyzedAt: '2026-03-07T00:00:00Z',
        errors: {},
      };
      vi.mocked(invoke).mockResolvedValue(mockBundle);

      const result = await globalToolRegistry.execute('analyze_reference_video', {
        assetId: 'ref-1',
        options: {
          shots: true,
          transcript: false,
          audio: false,
          segments: false,
          visual: false,
          localOnly: true,
        },
      });
      expect(result.success).toBe(true);
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('analyze_video_full', {
        assetId: 'ref-1',
        options: {
          shots: true,
          transcript: false,
          audio: false,
          segments: false,
          visual: false,
          localOnly: true,
        },
      });
    });
  });

  // ===========================================================================
  // generate_source_analysis_report
  // ===========================================================================

  describe('generate_source_analysis_report', () => {
    it('should build a cached source analysis report with markdown and annotation summaries', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'source-1',
            name: 'concert.mp4',
            kind: 'video',
            uri: '/media/concert.mp4',
            durationSec: 12,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      const mockBundle = {
        assetId: 'source-1',
        shots: [
          { startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' },
          { startSec: 4, endSec: 12, confidence: 0.84, keyframePath: 'shots/0002.jpg' },
        ],
        transcript: [
          {
            startSec: 0,
            endSec: 3,
            text: 'Hello crowd and welcome back',
            confidence: 0.97,
            language: 'en',
            speakerId: 'speaker_1',
          },
        ],
        audioProfile: {
          bpm: 120,
          spectralCentroidHz: 1400,
          loudnessProfile: [-18.2, -16.8, -17.4],
          peakDb: -3.1,
          silenceRegions: [{ startSec: 10, endSec: 11 }],
          speechRegions: [
            { startSec: 0, endSec: 10 },
            { startSec: 11, endSec: 12 },
          ],
        },
        segments: [
          {
            startSec: 0,
            endSec: 12,
            segmentType: 'performance',
            confidence: 0.93,
            features: {},
          },
        ],
        frameAnalysis: [
          {
            shotIndex: 0,
            cameraAngle: 'wide',
            subjectPosition: 'center',
            motionDirection: 'static',
            visualComplexity: 0.42,
          },
        ],
        metadata: {
          durationSec: 12,
          width: 1920,
          height: 1080,
          fps: 30,
          codec: 'h264',
          hasAudio: true,
        },
        analyzedAt: '2026-03-07T00:00:00Z',
        errors: {},
      };

      const mockAnnotationResponse = {
        annotation: {
          version: '1.0',
          assetId: 'source-1',
          assetHash: 'hash-1',
          createdAt: '2026-03-07T00:00:00Z',
          updatedAt: '2026-03-07T00:01:00Z',
          analysis: {
            objects: {
              provider: 'google_cloud',
              analyzedAt: '2026-03-07T00:01:00Z',
              config: {},
              costCents: 12,
              results: [
                {
                  timeSec: 1.2,
                  labels: ['person', 'microphone'],
                  confidence: 0.96,
                  boundingBox: null,
                },
              ],
            },
            faces: {
              provider: 'google_cloud',
              analyzedAt: '2026-03-07T00:01:00Z',
              config: {},
              costCents: 6,
              results: [
                {
                  timeSec: 1.4,
                  confidence: 0.93,
                  boundingBox: { left: 0.1, top: 0.2, width: 0.3, height: 0.3 },
                  emotions: ['happy'],
                  faceId: 'face-1',
                },
              ],
            },
            textOcr: {
              provider: 'google_cloud',
              analyzedAt: '2026-03-07T00:01:00Z',
              config: {},
              costCents: 4,
              results: [
                {
                  timeSec: 2,
                  text: 'LIVE',
                  confidence: 0.88,
                  boundingBox: null,
                  language: 'en',
                },
              ],
            },
          },
        },
        status: 'completed',
      };

      vi.mocked(invoke)
        .mockResolvedValueOnce(mockBundle)
        .mockResolvedValueOnce(mockAnnotationResponse);

      const result = await globalToolRegistry.execute('generate_source_analysis_report', {
        assetId: 'source-1',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.bundleSource).toBe('cached');
      expect(data.shots.count).toBe(2);
      expect(data.transcript.segmentCount).toBe(1);
      expect(data.moments.count).toBe(2);
      expect(data.moments.items[0].keyframePath).toBe('shots/0001.jpg');
      expect(data.moments.items[0].topObjectLabels).toContain('person');
      expect(data.moments.items[0].audioCue).toBe('speech-heavy');
      expect(data.audio.speechRegionCount).toBe(2);
      expect(data.audio.speechDurationSec).toBe(11);
      expect(data.audio.speechSharePercent).toBeCloseTo(91.67, 1);
      expect(data.transcript.speakerTurnCount).toBe(1);
      expect(data.speakerTurns.count).toBe(1);
      expect(data.speakerTurns.items[0].label).toBe('speaker_1');
      expect(data.chapters.count).toBeGreaterThan(0);
      expect(data.highlights.count).toBeGreaterThan(0);
      expect(data.annotations.objectDetectionCount).toBe(1);
      expect(data.annotations.availableTypes).toContain('objects');
      expect(data.annotations.providers).toContain('google_cloud');
      expect(String(data.markdown)).toContain('# Source Analysis Report: concert.mp4');
      expect(String(data.markdown)).toContain('## Moments');
      expect(String(data.markdown)).toContain('## Chapters');
      expect(String(data.markdown)).toContain('## Candidate Highlights');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'get_analysis_bundle', {
        assetId: 'source-1',
      });
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, 'get_annotation', {
        assetId: 'source-1',
      });
    });

    it('should regenerate the bundle when cached coverage is incomplete', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'source-2',
            name: 'interview.mp4',
            kind: 'video',
            uri: '/media/interview.mp4',
            durationSec: 6,
            video: {
              width: 1280,
              height: 720,
              fps: { num: 24, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      const partialBundle = {
        assetId: 'source-2',
        shots: [{ startSec: 0, endSec: 6, confidence: 0.81, keyframePath: null }],
        transcript: null,
        audioProfile: null,
        segments: null,
        frameAnalysis: null,
        metadata: {
          durationSec: 6,
          width: 1280,
          height: 720,
          fps: 24,
          codec: 'h264',
          hasAudio: true,
        },
        analyzedAt: '2026-03-07T00:00:00Z',
        errors: {},
      };

      const fullBundle = {
        ...partialBundle,
        transcript: [
          {
            startSec: 0,
            endSec: 2,
            text: 'This is a fresh transcript',
            confidence: 0.94,
            language: 'en',
            speakerId: 'speaker_a',
          },
        ],
        audioProfile: {
          bpm: 98,
          spectralCentroidHz: 900,
          loudnessProfile: [-20.1, -18.4],
          peakDb: -5.3,
          silenceRegions: [],
        },
        segments: [
          {
            startSec: 0,
            endSec: 6,
            segmentType: 'talk',
            confidence: 0.89,
            features: {},
          },
        ],
        frameAnalysis: [],
      };

      vi.mocked(invoke)
        .mockResolvedValueOnce(partialBundle)
        .mockResolvedValueOnce(fullBundle)
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('generate_source_analysis_report', {
        assetId: 'source-2',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.bundleSource).toBe('generated');
      expect(data.transcript.segmentCount).toBe(1);
      expect(data.moments.count).toBe(1);
      expect(data.chapters.count).toBeGreaterThan(0);
      expect(data.highlights.count).toBeGreaterThan(0);
      expect(data.warnings).toContain(
        'Visual composition analysis is missing. Enable visual analysis for framing and motion cues.',
      );
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'get_analysis_bundle', {
        assetId: 'source-2',
      });
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, 'analyze_video_full', {
        assetId: 'source-2',
        options: {
          shots: true,
          transcript: true,
          audio: true,
          segments: true,
          visual: true,
          localOnly: false,
        },
      });
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(3, 'get_annotation', {
        assetId: 'source-2',
      });
    });

    it('should reject non-video assets before invoking backend analysis', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'audio-1',
            name: 'voiceover.wav',
            kind: 'audio',
            uri: '/media/voiceover.wav',
            durationSec: 12,
          }),
        ],
      });

      const result = await globalToolRegistry.execute('generate_source_analysis_report', {
        assetId: 'audio-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('video assets');
      expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    });

    it('should prefer analyzed bundle duration over stale asset duration', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'source-3',
            name: 'stale-metadata.mp4',
            kind: 'video',
            uri: '/media/stale-metadata.mp4',
            durationSec: 120,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'source-3',
          shots: [{ startSec: 0, endSec: 10, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [],
          audioProfile: {
            bpm: null,
            spectralCentroidHz: 800,
            loudnessProfile: [-18.5],
            peakDb: -4.2,
            silenceRegions: [],
          },
          segments: [
            { startSec: 0, endSec: 10, segmentType: 'talk', confidence: 0.8, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 10,
            width: null,
            height: null,
            fps: null,
            codec: null,
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('generate_source_analysis_report', {
        assetId: 'source-3',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.metadata.durationSec).toBe(10);
      expect(data.metadata.width).toBe(1920);
      expect(data.metadata.height).toBe(1080);
      expect(data.metadata.fps).toBe(30);
      expect(data.metadata.codec).toBe('h264');
      expect(data.segments.distribution[0].sharePercent).toBe(100);
    });
  });

  // ===========================================================================
  // search_source_analysis_report
  // ===========================================================================

  describe('search_source_analysis_report', () => {
    it('should return ranked matches from moments and highlights', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'search-1',
            name: 'searchable.mp4',
            kind: 'video',
            uri: '/media/searchable.mp4',
            durationSec: 12,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'search-1',
          shots: [
            { startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' },
            { startSec: 4, endSec: 8, confidence: 0.88, keyframePath: 'shots/0002.jpg' },
          ],
          transcript: [
            {
              startSec: 0.5,
              endSec: 2.5,
              text: 'The crowd is cheering loudly',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
            },
          ],
          audioProfile: {
            bpm: 110,
            spectralCentroidHz: 1200,
            loudnessProfile: [-18.2],
            peakDb: -4.2,
            silenceRegions: [],
          },
          segments: [
            { startSec: 0, endSec: 8, segmentType: 'performance', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [
            {
              shotIndex: 0,
              cameraAngle: 'wide',
              subjectPosition: 'center',
              motionDirection: 'static',
              visualComplexity: 0.4,
            },
          ],
          metadata: {
            durationSec: 8,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({
          annotation: {
            version: '1.0',
            assetId: 'search-1',
            assetHash: 'hash-search',
            createdAt: '2026-03-07T00:00:00Z',
            updatedAt: '2026-03-07T00:01:00Z',
            analysis: {
              objects: {
                provider: 'google_cloud',
                analyzedAt: '2026-03-07T00:01:00Z',
                config: {},
                costCents: 10,
                results: [
                  {
                    timeSec: 1.0,
                    labels: ['crowd', 'person'],
                    confidence: 0.96,
                    boundingBox: null,
                  },
                ],
              },
              textOcr: {
                provider: 'google_cloud',
                analyzedAt: '2026-03-07T00:01:00Z',
                config: {},
                costCents: 3,
                results: [
                  {
                    timeSec: 1.5,
                    text: 'CHEER',
                    confidence: 0.88,
                    boundingBox: null,
                    language: 'en',
                  },
                ],
              },
            },
          },
          status: 'completed',
        });

      const result = await globalToolRegistry.execute('search_source_analysis_report', {
        assetId: 'search-1',
        query: 'crowd cheer',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBeGreaterThan(0);
      expect(data.matches[0].sectionType).toBe('moments');
      expect(data.matches[0].whyMatched).toContain('summary');
      expect(data.matches[0].keyframePath).toBe('shots/0001.jpg');
    });

    it('should honor section filters and limit', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'search-2',
            name: 'filterable.mp4',
            kind: 'video',
            uri: '/media/filterable.mp4',
            durationSec: 12,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'search-2',
          shots: [{ startSec: 0, endSec: 6, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [
            {
              startSec: 0,
              endSec: 3,
              text: 'Welcome back to the show',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
            },
          ],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18.2],
            peakDb: -4,
            silenceRegions: [],
          },
          segments: [
            { startSec: 0, endSec: 6, segmentType: 'talk', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 6,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('search_source_analysis_report', {
        assetId: 'search-2',
        query: 'welcome',
        sections: ['chapters'],
        limit: 1,
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBe(1);
      expect(data.matches[0].sectionType).toBe('chapters');
    });

    it('should search inferred speaker turns when requested', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'search-2b',
            name: 'turns.mp4',
            kind: 'video',
            uri: '/media/turns.mp4',
            durationSec: 6,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'search-2b',
          shots: [{ startSec: 0, endSec: 6, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [
            {
              startSec: 0,
              endSec: 2,
              text: 'Welcome back to the show.',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
              speakerTurnId: 'turn_001',
            },
            {
              startSec: 3,
              endSec: 5,
              text: 'Thanks for having me.',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_2',
              speakerTurnId: 'turn_002',
            },
          ],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18.2],
            peakDb: -4,
            silenceRegions: [{ startSec: 2, endSec: 3 }],
            speechRegions: [
              { startSec: 0, endSec: 2 },
              { startSec: 3, endSec: 5 },
            ],
          },
          segments: [
            { startSec: 0, endSec: 6, segmentType: 'talk', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 6,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('search_source_analysis_report', {
        assetId: 'search-2b',
        query: 'having me',
        sections: ['speakerTurns'],
        limit: 5,
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBeGreaterThan(0);
      expect(data.matches[0].sectionType).toBe('speakerTurns');
      expect(String(data.matches[0].preview)).toContain('having me');
    });

    it('should search moments beyond the twelfth shot', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'search-3',
            name: 'long-searchable.mp4',
            kind: 'video',
            uri: '/media/long-searchable.mp4',
            durationSec: 26,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      const shots = Array.from({ length: 13 }, (_, index) => ({
        startSec: index * 2,
        endSec: index * 2 + 2,
        confidence: 0.9,
        keyframePath: `shots/${String(index + 1).padStart(4, '0')}.jpg`,
      }));

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'search-3',
          shots,
          transcript: [
            {
              startSec: 24.2,
              endSec: 25.4,
              text: 'Late fireworks finale',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
            },
          ],
          audioProfile: {
            bpm: 110,
            spectralCentroidHz: 1200,
            loudnessProfile: [-18.2],
            peakDb: -4.2,
            silenceRegions: [],
          },
          segments: [
            { startSec: 0, endSec: 26, segmentType: 'performance', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 26,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('search_source_analysis_report', {
        assetId: 'search-3',
        query: 'fireworks finale',
        sections: ['moments'],
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBeGreaterThan(0);
      expect(data.matches[0].startSec).toBe(24);
    });

    it('should allow more than twenty report matches when requested', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'search-4',
            name: 'many-matches.mp4',
            kind: 'video',
            uri: '/media/many-matches.mp4',
            durationSec: 50,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      const shots = Array.from({ length: 25 }, (_, index) => ({
        startSec: index * 2,
        endSec: index * 2 + 2,
        confidence: 0.9,
        keyframePath: `shots/${String(index + 1).padStart(4, '0')}.jpg`,
      }));

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'search-4',
          shots,
          transcript: shots.map((shot, index) => ({
            startSec: shot.startSec,
            endSec: shot.endSec,
            text: `Crowd cheer ${index + 1}`,
            confidence: 0.95,
            language: 'en',
            speakerId: 'speaker_1',
          })),
          audioProfile: {
            bpm: 110,
            spectralCentroidHz: 1200,
            loudnessProfile: [-18.2],
            peakDb: -4.2,
            silenceRegions: [],
            speechRegions: [{ startSec: 0, endSec: 50 }],
          },
          segments: [
            { startSec: 0, endSec: 50, segmentType: 'performance', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 50,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('search_source_analysis_report', {
        assetId: 'search-4',
        query: 'crowd cheer',
        sections: ['moments'],
        limit: 30,
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBe(25);
    });
  });

  // ===========================================================================
  // search_source_library
  // ===========================================================================

  describe('search_source_library', () => {
    it('should rank matches across multiple assets', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'lib-1',
            name: 'concert.mp4',
            kind: 'video',
            uri: '/media/concert.mp4',
            durationSec: 8,
            importedAt: '2026-01-02T00:00:00.000Z',
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
          createAsset({
            id: 'lib-2',
            name: 'interview.mp4',
            kind: 'video',
            uri: '/media/interview.mp4',
            durationSec: 8,
            importedAt: '2026-01-01T00:00:00.000Z',
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'lib-1',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/lib1.jpg' }],
          transcript: [
            {
              startSec: 0.5,
              endSec: 2.5,
              text: 'Huge crowd cheer at the chorus',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
            },
          ],
          audioProfile: {
            bpm: 120,
            spectralCentroidHz: 1400,
            loudnessProfile: [-18.2],
            peakDb: -4.2,
            silenceRegions: [],
          },
          segments: [
            { startSec: 0, endSec: 4, segmentType: 'performance', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 4,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' })
        .mockResolvedValueOnce({
          assetId: 'lib-2',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/lib2.jpg' }],
          transcript: [
            {
              startSec: 0.5,
              endSec: 2.5,
              text: 'Quiet interview answer',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
            },
          ],
          audioProfile: {
            bpm: 90,
            spectralCentroidHz: 900,
            loudnessProfile: [-20.2],
            peakDb: -5.2,
            silenceRegions: [],
          },
          segments: [
            { startSec: 0, endSec: 4, segmentType: 'talk', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 4,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('search_source_library', {
        query: 'crowd cheer',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBeGreaterThan(0);
      expect(data.matches[0].assetId).toBe('lib-1');
      expect(data.matches[0].sectionType).toBe('moments');
    });

    it('should prefer speaker turns for dialogue-oriented library queries', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'lib-dialogue',
            name: 'interview.mp4',
            kind: 'video',
            uri: '/media/interview.mp4',
            durationSec: 12,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'lib-dialogue',
          shots: [{ startSec: 0, endSec: 8, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [
            {
              startSec: 0,
              endSec: 2,
              text: 'What happened next?',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
              speakerTurnId: 'turn_001',
            },
            {
              startSec: 2.5,
              endSec: 6,
              text: 'I answered the question in detail.',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_2',
              speakerTurnId: 'turn_002',
            },
          ],
          audioProfile: {
            bpm: 90,
            spectralCentroidHz: 1100,
            loudnessProfile: [-18.2],
            peakDb: -4.2,
            silenceRegions: [{ startSec: 2, endSec: 2.5 }],
            speechRegions: [
              { startSec: 0, endSec: 2 },
              { startSec: 2.5, endSec: 6 },
            ],
          },
          segments: [
            { startSec: 0, endSec: 8, segmentType: 'talk', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 8,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('search_source_library', {
        query: 'best answer quote',
        sections: ['moments', 'speakerTurns'],
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBeGreaterThan(0);
      expect(data.matches[0].sectionType).toBe('speakerTurns');
      expect(data.matches[0].rankingNotes).toContain('dialogue query prefers speaker turns');
    });

    it('should prefer quiet gaps for pause-oriented library queries', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'lib-pause',
            name: 'pause.mp4',
            kind: 'video',
            uri: '/media/pause.mp4',
            durationSec: 10,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'lib-pause',
          shots: [
            { startSec: 0, endSec: 2, confidence: 0.9, keyframePath: 'shots/0001.jpg' },
            { startSec: 2, endSec: 6, confidence: 0.9, keyframePath: 'shots/0002.jpg' },
          ],
          transcript: [
            {
              startSec: 0,
              endSec: 1,
              text: 'Hello there',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
              speakerTurnId: 'turn_001',
            },
          ],
          audioProfile: {
            bpm: 70,
            spectralCentroidHz: 900,
            loudnessProfile: [-22],
            peakDb: -6,
            silenceRegions: [{ startSec: 2, endSec: 6 }],
            speechRegions: [{ startSec: 0, endSec: 1 }],
          },
          segments: [
            { startSec: 0, endSec: 6, segmentType: 'talk', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 6,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('search_source_library', {
        query: 'quiet pause beat',
        sections: ['moments'],
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBeGreaterThan(0);
      expect(data.matches[0].metadata.audioCue).toBe('long pause');
      expect(data.matches[0].rankingNotes).toContain('pause query prefers long pauses');
    });

    it('should honor unusedOnly and avoid analyzing missing bundles by default', async () => {
      const usedClip = createClip({ id: 'used-clip', assetId: 'lib-used' });
      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [usedClip] })],
        assets: [
          createAsset({
            id: 'lib-used',
            name: 'used.mp4',
            kind: 'video',
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
          createAsset({
            id: 'lib-unused',
            name: 'unused.mp4',
            kind: 'video',
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('search_source_library', {
        query: 'anything',
        unusedOnly: true,
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.searchedAssetCount).toBe(1);
      expect(data.count).toBe(0);
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'get_analysis_bundle', {
        assetId: 'lib-unused',
      });
    });
  });

  // ===========================================================================
  // build_source_selects
  // ===========================================================================

  describe('build_source_selects', () => {
    it('should convert ranked source matches into a timeline-ready selects plan', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'select-1',
            name: 'concert.mp4',
            kind: 'video',
            uri: '/media/concert.mp4',
            durationSec: 10,
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'select-1',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [
            {
              startSec: 0.3,
              endSec: 2.8,
              text: 'Huge crowd cheer at the chorus',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
            },
          ],
          audioProfile: {
            bpm: 120,
            spectralCentroidHz: 1400,
            loudnessProfile: [-18.2],
            peakDb: -4.2,
            silenceRegions: [],
          },
          segments: [
            { startSec: 0, endSec: 4, segmentType: 'performance', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          metadata: {
            durationSec: 10,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('build_source_selects', {
        query: 'crowd cheer',
        paddingSec: 0.5,
        gapSec: 0.5,
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBe(1);
      expect(data.selects[0].assetId).toBe('select-1');
      expect(data.selects[0].sourceInSec).toBe(0);
      expect(data.selects[0].sourceOutSec).toBe(4.5);
      expect(data.timelinePlan.sequenceId).toBe('seq_001');
      expect(data.timelinePlan.steps[0].action).toBe('add_track');
      expect(data.timelinePlan.steps[1].action).toBe('insert_clip');
      expect(data.timelinePlan.steps[1].sourceInSec).toBe(0);
      expect(data.timelinePlan.steps[1].sourceOutSec).toBe(4.5);
    });

    it('should fail early when given an invalid target track id', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'select-2',
            kind: 'video',
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'select-2',
          shots: [{ startSec: 0, endSec: 2, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [],
          audioProfile: {
            bpm: 120,
            spectralCentroidHz: 1400,
            loudnessProfile: [-18.2],
            peakDb: -4.2,
            silenceRegions: [],
          },
          segments: [],
          frameAnalysis: [],
          metadata: {
            durationSec: 4,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('build_source_selects', {
        query: 'anything',
        trackId: 'missing-track',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Track 'missing-track' not found");
    });

    it('should fail when no active sequence exists for selects planning', async () => {
      setupStores({
        activeSequenceId: null,
        sequences: [],
        assets: [
          createAsset({
            id: 'select-3',
            kind: 'video',
            video: {
              width: 1920,
              height: 1080,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'select-3',
          shots: [{ startSec: 0, endSec: 2, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [],
          audioProfile: {
            bpm: 120,
            spectralCentroidHz: 1400,
            loudnessProfile: [-18.2],
            peakDb: -4.2,
            silenceRegions: [],
          },
          segments: [],
          frameAnalysis: [],
          metadata: {
            durationSec: 4,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: 'h264',
            hasAudio: true,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('build_source_selects', {
        query: 'anything',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active sequence found');
    });
  });

  // ===========================================================================
  // generate_style_document
  // ===========================================================================

  describe('generate_style_document', () => {
    it('should return ESD summary when given valid assetId', async () => {
      const existingEsdSummaries: Array<{ id: string; sourceAssetId: string; createdAt: string }> =
        [];
      const mockBundle = {
        assetId: 'ref-1',
        shots: [],
        transcript: null,
        audioProfile: null,
        segments: [],
        frameAnalysis: null,
        metadata: { durationSec: 10, width: 1920, height: 1080, fps: 30 },
        analyzedAt: '2026-03-07T00:00:00Z',
        errors: {},
      };
      const mockEsd = {
        id: 'esd-1',
        name: 'Test ESD',
        sourceAssetId: 'ref-1',
        createdAt: '2026-03-07T00:00:00Z',
        version: '1.0',
        rhythmProfile: {
          shotDurations: [2, 3, 1],
          meanDuration: 2,
          medianDuration: 2,
          stdDeviation: 0.82,
          minDuration: 1,
          maxDuration: 3,
          tempoClassification: 'moderate',
        },
        pacingCurve: [
          { time: 0, value: 2 },
          { time: 1, value: 3 },
        ],
        transitionInventory: [],
        audioSyncPatterns: [],
        contentStructure: [],
        cameraPatterns: [],
      };
      vi.mocked(invoke)
        .mockResolvedValueOnce(existingEsdSummaries)
        .mockResolvedValueOnce(mockBundle)
        .mockResolvedValueOnce(mockEsd);

      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'ref-1',
      });
      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({
        esdId: 'esd-1',
        name: 'Test ESD',
        tempoClassification: 'moderate',
        shotCount: 3,
        analysisSource: 'cached',
      });
    });

    it('should analyze first when no cached bundle exists', async () => {
      const existingEsdSummaries: Array<{ id: string; sourceAssetId: string; createdAt: string }> =
        [];
      const mockBundle = {
        assetId: 'ref-1',
        shots: [],
        transcript: null,
        audioProfile: null,
        segments: [],
        frameAnalysis: null,
        metadata: { durationSec: 5, width: 1280, height: 720, fps: 24 },
        analyzedAt: '2026-03-07T00:00:00Z',
        errors: {},
      };
      const mockEsd = {
        id: 'esd-2',
        name: 'ESD-ref-1',
        sourceAssetId: 'ref-1',
        createdAt: '2026-03-07T00:00:00Z',
        version: '1.0',
        rhythmProfile: {
          shotDurations: [1],
          meanDuration: 1,
          medianDuration: 1,
          stdDeviation: 0,
          minDuration: 1,
          maxDuration: 1,
          tempoClassification: 'fast',
        },
        pacingCurve: [],
        transitionInventory: [],
        audioSyncPatterns: [],
        contentStructure: [],
        cameraPatterns: [],
      };
      vi.mocked(invoke)
        .mockResolvedValueOnce(existingEsdSummaries)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockBundle)
        .mockResolvedValueOnce(mockEsd);

      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'ref-1',
      });
      const data = getToolResult<Record<string, unknown>>(result);
      expect(data.analysisSource).toBe('generated');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'list_esds');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, 'get_analysis_bundle', {
        assetId: 'ref-1',
      });
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(3, 'analyze_video_full', {
        assetId: 'ref-1',
        options: {
          shots: true,
          transcript: true,
          audio: true,
          segments: true,
          visual: true,
          localOnly: false,
        },
      });
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(4, 'generate_esd', {
        bundle: mockBundle,
      });
    });

    it('should reuse the latest existing ESD for the same asset when available', async () => {
      const existingSummary = {
        id: 'esd-existing',
        name: 'Existing ESD',
        sourceAssetId: 'ref-1',
        createdAt: '2026-03-08T00:00:00Z',
        tempoClassification: 'moderate',
      };
      const existingEsd = {
        id: 'esd-existing',
        name: 'Existing ESD',
        sourceAssetId: 'ref-1',
        createdAt: '2026-03-08T00:00:00Z',
        version: '1.0.0',
        rhythmProfile: {
          shotDurations: [2, 3, 1],
          meanDuration: 2,
          medianDuration: 2,
          stdDeviation: 0.82,
          minDuration: 1,
          maxDuration: 3,
          tempoClassification: 'moderate',
        },
        pacingCurve: [
          { normalizedPosition: 0.2, normalizedDuration: 0.67 },
          { normalizedPosition: 0.7, normalizedDuration: 1 },
        ],
        transitionInventory: [],
        syncPoints: [],
        contentMap: [],
        cameraPatterns: [],
      };
      vi.mocked(invoke).mockResolvedValueOnce([existingSummary]).mockResolvedValueOnce(existingEsd);

      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'ref-1',
      });

      const data = getToolResult<Record<string, unknown>>(result);
      expect(data.esdId).toBe('esd-existing');
      expect(data.analysisSource).toBe('existing_esd');
      expect(String(data.summary)).toContain('Reused the latest existing ESD');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'list_esds');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, 'get_esd', {
        esdId: 'esd-existing',
      });
      expect(vi.mocked(invoke)).toHaveBeenCalledTimes(2);
    });

    it('should use backend-generated name (ESD names are auto-generated)', async () => {
      const mockBundle = {
        assetId: 'ref-1',
        shots: [],
        transcript: null,
        audioProfile: null,
        segments: [],
        frameAnalysis: null,
        metadata: { durationSec: 5, width: 1280, height: 720, fps: 24 },
        analyzedAt: '2026-03-07T00:00:00Z',
        errors: {},
      };
      const mockEsd = {
        id: 'esd-2',
        name: 'ESD-ref-1',
        sourceAssetId: 'ref-1',
        createdAt: '2026-03-07T00:00:00Z',
        version: '1.0',
        rhythmProfile: {
          shotDurations: [1],
          meanDuration: 1,
          medianDuration: 1,
          stdDeviation: 0,
          minDuration: 1,
          maxDuration: 1,
          tempoClassification: 'fast',
        },
        pacingCurve: [],
        transitionInventory: [],
        audioSyncPatterns: [],
        contentStructure: [],
        cameraPatterns: [],
      };
      // list_esds returns empty (no existing ESD), then bundle + esd generation
      vi.mocked(invoke)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(mockBundle)
        .mockResolvedValueOnce(mockEsd);

      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'ref-1',
      });
      const data = getToolResult<Record<string, unknown>>(result);
      expect(data.name).toBe('ESD-ref-1');
      expect(data).not.toHaveProperty('requestedName');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'list_esds');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, 'get_analysis_bundle', {
        assetId: 'ref-1',
      });
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(3, 'generate_esd', {
        bundle: mockBundle,
      });
    });

    it('should fail when assetId is missing', async () => {
      const result = await globalToolRegistry.execute('generate_style_document', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('assetId');
    });

    it('should handle IPC error', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('Analysis not found'));
      const result = await globalToolRegistry.execute('generate_style_document', {
        assetId: 'no-analysis',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Analysis not found');
    });
  });

  // ===========================================================================
  // compare_edit_structure
  // ===========================================================================

  describe('compare_edit_structure', () => {
    it('should compute correlation when ESD and timeline clips match perfectly', async () => {
      const mockEsd = {
        id: 'esd-1',
        name: 'Test',
        sourceAssetId: 'ref-1',
        createdAt: '2026-03-07T00:00:00Z',
        version: '1.0',
        rhythmProfile: {
          shotDurations: [2, 3, 5],
          meanDuration: 3.33,
          medianDuration: 3,
          stdDeviation: 1.25,
          minDuration: 2,
          maxDuration: 5,
          tempoClassification: 'moderate',
        },
        pacingCurve: [],
        transitionInventory: [],
        audioSyncPatterns: [],
        contentStructure: [],
        cameraPatterns: [],
      };
      vi.mocked(invoke).mockResolvedValue(mockEsd);

      // Setup store with clips whose durations match the ESD shot durations [2, 3, 5]
      setupStores({
        tracks: [
          createTrack({
            id: 'V1',
            clips: [
              createClip({
                id: 'c1',
                assetId: 'a1',
                place: { timelineInSec: 0, durationSec: 2 },
              }),
              createClip({
                id: 'c2',
                assetId: 'a2',
                place: { timelineInSec: 2, durationSec: 3 },
              }),
              createClip({
                id: 'c3',
                assetId: 'a3',
                place: { timelineInSec: 5, durationSec: 5 },
              }),
            ],
          }),
        ],
      });

      const result = await globalToolRegistry.execute('compare_edit_structure', {
        esdId: 'esd-1',
      });
      const data = getToolResult<Record<string, unknown>>(result);
      expect(data.referenceShots).toBe(3);
      expect(data.outputShots).toBe(3);
      expect(data.correlation).toBe(1); // Perfect match
    });

    it('should fail when esdId is missing', async () => {
      const result = await globalToolRegistry.execute('compare_edit_structure', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('esdId');
    });

    it('should return a clear error when the ESD does not exist', async () => {
      vi.mocked(invoke).mockResolvedValue(null);
      setupStores({
        tracks: [createTrack({ id: 'V1' })],
      });

      const result = await globalToolRegistry.execute('compare_edit_structure', {
        esdId: 'nonexistent',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ESD not found');
    });

    it('should return zero correlation when timeline has no clips', async () => {
      const mockEsd = {
        id: 'esd-1',
        name: 'Test',
        sourceAssetId: 'ref-1',
        createdAt: '2026-03-07T00:00:00Z',
        version: '1.0',
        rhythmProfile: {
          shotDurations: [2, 3],
          meanDuration: 2.5,
          medianDuration: 2.5,
          stdDeviation: 0.5,
          minDuration: 2,
          maxDuration: 3,
          tempoClassification: 'moderate',
        },
        pacingCurve: [],
        transitionInventory: [],
        audioSyncPatterns: [],
        contentStructure: [],
        cameraPatterns: [],
      };
      vi.mocked(invoke).mockResolvedValue(mockEsd);

      // Empty timeline - no clips
      setupStores({
        tracks: [createTrack({ id: 'V1', clips: [] })],
      });

      const result = await globalToolRegistry.execute('compare_edit_structure', {
        esdId: 'esd-1',
      });
      const data = getToolResult<Record<string, unknown>>(result);
      expect(data.outputShots).toBe(0);
      expect(data.correlation).toBe(0);
    });
  });
});

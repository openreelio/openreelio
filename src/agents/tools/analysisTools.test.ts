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
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { Track, Clip, Asset, Sequence } from '@/types';
import { createMockAsset, createMockClip, createMockTrack, createMockSequence } from '@/test/mocks';
import { invoke } from '@tauri-apps/api/core';
import { executeAgentCommand } from './commandExecutor';
import {
  readWorkspaceDocumentFromBackend,
  writeWorkspaceDocumentToBackend,
} from '@/services/workspaceGateway';

vi.mock('./commandExecutor', () => ({
  executeAgentCommand: vi.fn(),
}));

vi.mock('@/services/workspaceGateway', () => ({
  readWorkspaceDocumentFromBackend: vi.fn(),
  writeWorkspaceDocumentToBackend: vi.fn(),
}));

const workspaceDocuments = new Map<
  string,
  {
    content: string;
    modifiedAtUnixSec: number;
  }
>();

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
    workspaceDocuments.clear();
    globalToolRegistry.clear();
    registerAnalysisTools();
    vi.mocked(executeAgentCommand).mockReset();
    vi.mocked(writeWorkspaceDocumentToBackend).mockImplementation(async (relativePath, content) => {
      const modifiedAtUnixSec = workspaceDocuments.size + 1;
      workspaceDocuments.set(relativePath, { content, modifiedAtUnixSec });
      return {
        relativePath,
        bytesWritten: content.length,
        created: true,
      };
    });
    vi.mocked(readWorkspaceDocumentFromBackend).mockImplementation(async (relativePath) => {
      const document = workspaceDocuments.get(relativePath);
      if (!document) {
        throw new Error(`Workspace document not found: ${relativePath}`);
      }

      return {
        relativePath,
        content: document.content,
        sizeBytes: document.content.length,
        modifiedAtUnixSec: document.modifiedAtUnixSec,
      };
    });

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
    useWorkspaceStore.setState({
      fileTree: [],
      error: null,
    });
  });

  afterEach(() => {
    workspaceDocuments.clear();
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
      expect(analysisTools.length).toBe(28);
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
      expect(names).toContain('read_source_analysis_report');
      expect(names).toContain('generate_source_analysis_report');
      expect(names).toContain('search_source_analysis_report');
      expect(names).toContain('search_source_library');
      expect(names).toContain('search_indexed_source_library');
      expect(names).toContain('build_source_selects');
      expect(names).toContain('search_indexed_source_library');
      expect(names).toContain('import_external_diarization');
      expect(names).toContain('run_external_diarization');
      expect(names).toHaveLength(28);
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
  // read_source_analysis_report
  // ===========================================================================

  describe('read_source_analysis_report', () => {
    it('should generate, persist, and return the canonical Markdown report document', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'read-source-1',
            name: 'readable.mp4',
            kind: 'video',
            uri: '/media/readable.mp4',
            relativePath: 'media/readable.mp4',
            durationSec: 8,
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
          assetId: 'read-source-1',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [
            {
              startSec: 0,
              endSec: 2,
              text: 'A concise transcript excerpt',
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
            speechRegions: [{ startSec: 0, endSec: 4 }],
          },
          segments: [
            { startSec: 0, endSec: 4, segmentType: 'talk', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          contactSheet: null,
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

      const result = await globalToolRegistry.execute('read_source_analysis_report', {
        assetId: 'read-source-1',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.assetId).toBe('read-source-1');
      expect(data.relativePath).toBe('media/readable.analysis.md');
      expect(data.reportPath).toBe('media/readable.analysis.md');
      expect(data.document.relativePath).toBe('media/readable.analysis.md');
      expect(vi.mocked(writeWorkspaceDocumentToBackend)).toHaveBeenCalled();
      expect(String(data.content)).toContain('# Source Analysis Report: readable.mp4');
      expect(String(data.document.content)).toContain('# Source Analysis Report: readable.mp4');
      expect(data.sectionCounts).toMatchObject({
        moments: 1,
        chapters: expect.any(Number),
        highlights: expect.any(Number),
        speakerTurns: 1,
      });
    });

    it('should resolve a workspace file argument into an asset before reading', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'read-source-file',
            name: 'library.mp4',
            kind: 'video',
            uri: '/media/library.mp4',
            relativePath: 'media/library.mp4',
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
      useWorkspaceStore.setState({
        fileTree: [
          {
            name: 'library.mp4',
            relativePath: 'media/library.mp4',
            isDirectory: false,
            fileSize: 1024,
            kind: 'video',
            assetId: 'read-source-file',
            children: [],
          },
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'read-source-file',
          shots: [{ startSec: 0, endSec: 6, confidence: 0.9, keyframePath: null }],
          transcript: [],
          audioProfile: {
            bpm: null,
            spectralCentroidHz: 900,
            loudnessProfile: [-19],
            peakDb: -5,
            silenceRegions: [],
          },
          segments: [
            { startSec: 0, endSec: 6, segmentType: 'broll', confidence: 0.85, features: {} },
          ],
          frameAnalysis: [],
          contactSheet: null,
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
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('read_source_analysis_report', {
        file: 'library.mp4',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.assetId).toBe('read-source-file');
      expect(data.requestedFile).toBe('media/library.mp4');
      expect(data.relativePath).toBe('media/library.analysis.md');
    });

    it('should honor a custom outputPath when provided', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'read-source-custom',
            name: 'custom.mp4',
            kind: 'video',
            uri: '/media/custom.mp4',
            relativePath: 'media/custom.mp4',
            durationSec: 5,
            video: {
              width: 1280,
              height: 720,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'read-source-custom',
          shots: [],
          transcript: [],
          audioProfile: {
            bpm: null,
            spectralCentroidHz: 1000,
            loudnessProfile: [-20],
            peakDb: -6,
            silenceRegions: [],
            speechRegions: [],
          },
          segments: [],
          frameAnalysis: [],
          contactSheet: null,
          metadata: {
            durationSec: 5,
            width: 1280,
            height: 720,
            fps: 30,
            codec: 'h264',
            hasAudio: false,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('read_source_analysis_report', {
        assetId: 'read-source-custom',
        outputPath: 'reports/custom-output.md',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.relativePath).toBe('reports/custom-output.md');
      expect(data.reportPath).toBe('reports/custom-output.md');
    });

    it('should reject a custom outputPath that would overwrite the source asset', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'read-source-overwrite',
            name: 'overwrite.mp4',
            kind: 'video',
            uri: '/media/overwrite.mp4',
            relativePath: 'media/overwrite.mp4',
            durationSec: 5,
            video: {
              width: 1280,
              height: 720,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'read-source-overwrite',
          shots: [],
          transcript: [],
          audioProfile: {
            bpm: null,
            spectralCentroidHz: 1000,
            loudnessProfile: [-20],
            peakDb: -6,
            silenceRegions: [],
            speechRegions: [],
          },
          segments: [],
          frameAnalysis: [],
          contactSheet: null,
          metadata: {
            durationSec: 5,
            width: 1280,
            height: 720,
            fps: 30,
            codec: 'h264',
            hasAudio: false,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });

      const result = await globalToolRegistry.execute('read_source_analysis_report', {
        assetId: 'read-source-overwrite',
        outputPath: 'media/overwrite.mp4',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('outputPath cannot overwrite the source asset');
      expect(vi.mocked(writeWorkspaceDocumentToBackend)).not.toHaveBeenCalled();
    });

    it('should keep persisted true when the report cannot be re-read after writing', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'read-source-reread-fail',
            name: 'reread.mp4',
            kind: 'video',
            uri: '/media/reread.mp4',
            relativePath: 'media/reread.mp4',
            durationSec: 5,
            video: {
              width: 1280,
              height: 720,
              fps: { num: 30, den: 1 },
              codec: 'h264',
              hasAlpha: false,
            },
          }),
        ],
      });

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'read-source-reread-fail',
          shots: [],
          transcript: [],
          audioProfile: {
            bpm: null,
            spectralCentroidHz: 1000,
            loudnessProfile: [-20],
            peakDb: -6,
            silenceRegions: [],
            speechRegions: [],
          },
          segments: [],
          frameAnalysis: [],
          contactSheet: null,
          metadata: {
            durationSec: 5,
            width: 1280,
            height: 720,
            fps: 30,
            codec: 'h264',
            hasAudio: false,
          },
          analyzedAt: '2026-03-07T00:00:00Z',
          errors: {},
        })
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' });
      vi.mocked(writeWorkspaceDocumentToBackend).mockResolvedValueOnce({
        relativePath: 'media/reread.analysis.md',
        bytesWritten: 428,
        created: true,
      });

      const result = await globalToolRegistry.execute('read_source_analysis_report', {
        assetId: 'read-source-reread-fail',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.persisted).toBe(true);
      expect(typeof data.persistenceError).toBe('string');
      expect(String(data.persistenceError).length).toBeGreaterThan(0);
      expect(data.document.persisted).toBe(true);
      expect(typeof data.document.persistenceError).toBe('string');
      expect(String(data.document.persistenceError).length).toBeGreaterThan(0);
      expect(data.relativePath).toBe('media/reread.analysis.md');
      expect(data.sizeBytes).toBe(String(data.content).length);
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
            relativePath: 'media/concert.mp4',
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
          {
            startSec: 0,
            endSec: 4,
            confidence: 0.9,
            keyframePath: 'shots/0001.jpg',
            keyframeSelectionMethod: 'thumbnail',
          },
          {
            startSec: 4,
            endSec: 12,
            confidence: 0.84,
            keyframePath: 'shots/0002.jpg',
            keyframeSelectionMethod: 'thumbnail',
          },
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
        contactSheet: {
          path: '/analysis/source-1/contact-sheet.jpg',
          frameCount: 2,
          columns: 2,
          rows: 1,
        },
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
      expect(data.shots.firstShots[0].keyframeSelectionMethod).toBe('thumbnail');
      expect(data.moments.items[0].topObjectLabels).toContain('person');
      expect(data.moments.items[0].audioCue).toBe('speech-heavy');
      expect(data.audio.speechRegionCount).toBe(2);
      expect(data.audio.speechDurationSec).toBe(11);
      expect(data.audio.speechSharePercent).toBeCloseTo(91.67, 1);
      expect(data.transcript.speakerTurnCount).toBe(1);
      expect(data.speakerTurns.count).toBe(1);
      expect(data.speakerTurns.items[0].label).toBe('speaker_1');
      expect(data.visual.contactSheet.path).toBe('/analysis/source-1/contact-sheet.jpg');
      expect(data.visual.items).toEqual([
        {
          shotIndex: 0,
          startSec: 0,
          endSec: 4,
          durationSec: 4,
          keyframePath: 'shots/0001.jpg',
          keyframeSelectionMethod: 'thumbnail',
          cameraAngle: 'wide',
          subjectPosition: 'center',
          motionDirection: 'static',
          visualComplexity: 0.42,
          summary: 'Shot 1 | wide angle | center subject | static motion | complexity 0.42',
        },
      ]);
      expect(String(data.summary)).toContain('Performance or stage moment');
      expect(data.moments.items[0].sceneLabel).toBe('Performance moment');
      expect(String(data.moments.items[0].summary)).toContain('Performance or stage moment');
      expect(String(data.moments.items[0].summary)).toContain(
        'People: at least one recurring face is visible',
      );
      expect(String(data.moments.items[0].summary)).toContain('Text: on-screen text reads "LIVE"');
      expect(data.semantic.whatIsHappening.length).toBeGreaterThan(0);
      expect(data.semantic.whoIsPresent.length).toBeGreaterThan(0);
      expect(data.semantic.whatIsHeard.length).toBeGreaterThan(0);
      expect(data.semantic.onScreenText.length).toBeGreaterThan(0);
      expect(data.semantic.likelySetting).toContain('stage or live event setting');
      expect(data.semantic.sceneTimeline[0].title).toBe('Performance moment');
      expect(data.semantic.usefulMoments[0].kind).toBe('text');
      expect(data.chapters.count).toBeGreaterThan(0);
      expect(data.highlights.count).toBeGreaterThan(0);
      expect(data.annotations.objectDetectionCount).toBe(1);
      expect(data.annotations.availableTypes).toContain('objects');
      expect(data.annotations.providers).toContain('google_cloud');
      expect(data.relativePath).toBe('media/concert.analysis.md');
      expect(data.reportPath).toBe('media/concert.analysis.md');
      expect(String(data.content)).toContain('# Source Analysis Report: concert.mp4');
      expect(String(data.markdown)).toContain('# Source Analysis Report: concert.mp4');
      expect(String(data.markdown)).toContain('## Executive Summary');
      expect(String(data.markdown)).toContain('## Scene Timeline');
      expect(String(data.markdown)).toContain('## Useful Moments');
      expect(String(data.markdown)).toContain('## Who Is Present');
      expect(String(data.markdown)).toContain('## What Is Heard');
      expect(String(data.markdown)).toContain('## On-Screen Text');
      expect(String(data.markdown)).toContain('## Visual / Setting Cues');
      expect(String(data.markdown)).toContain('## Moments');
      expect(String(data.markdown)).toContain('What is happening:');
      expect(String(data.markdown)).toContain('Likely setting: stage or live event setting');
      expect(String(data.markdown)).toContain('Best usable moment: 00:00-00:03 | text |');
      expect(String(data.markdown)).toContain('00:00-00:03 | Performance moment |');
      expect(String(data.markdown)).toContain('## Visual Breakdown');
      expect(String(data.markdown)).toContain(
        '00:00-00:04 | Shot 1 | wide angle | center subject | static motion | complexity 0.42',
      );
      expect(String(data.markdown)).toContain('Keyframe: shots/0001.jpg');
      expect(String(data.markdown)).toContain('## Visual Artifacts');
      expect(String(data.markdown)).toContain('## Chapters');
      expect(String(data.markdown)).toContain('## Candidate Highlights');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'get_analysis_bundle', {
        assetId: 'source-1',
      });
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, 'get_annotation', {
        assetId: 'source-1',
      });
    });

    it('should truncate visual breakdown markdown preview without truncating structured visual items', async () => {
      const shots = Array.from({ length: 13 }, (_, index) => ({
        startSec: index * 2,
        endSec: index * 2 + 2,
        confidence: 0.9,
        keyframePath: `shots/${String(index + 1).padStart(4, '0')}.jpg`,
        keyframeSelectionMethod: 'thumbnail',
      }));

      setupStores({
        assets: [
          createAsset({
            id: 'source-visual-preview',
            name: 'visual-preview.mp4',
            kind: 'video',
            uri: '/media/visual-preview.mp4',
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

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'source-visual-preview',
          shots,
          transcript: [],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18],
            peakDb: -4,
            silenceRegions: [],
            speechRegions: [{ startSec: 0, endSec: 26 }],
          },
          segments: [
            { startSec: 0, endSec: 26, segmentType: 'performance', confidence: 0.9, features: {} },
          ],
          frameAnalysis: Array.from({ length: 13 }, (_, index) => ({
            shotIndex: index,
            cameraAngle: 'wide',
            subjectPosition: 'center',
            motionDirection: 'static',
            visualComplexity: 0.5,
          })),
          contactSheet: null,
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

      const result = await globalToolRegistry.execute('generate_source_analysis_report', {
        assetId: 'source-visual-preview',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.visual.items).toHaveLength(13);
      expect(String(data.markdown)).toContain('## Visual Breakdown');
      expect(String(data.markdown)).toContain(
        '- ... 1 more visual entries omitted from Markdown preview',
      );
      expect(String(data.markdown)).not.toContain(
        '00:24-00:26 | Shot 13 | wide angle | center subject | static motion | complexity 0.5',
      );
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
  // import_external_diarization
  // ===========================================================================

  describe('import_external_diarization', () => {
    it('should import external diarization and return updated counts', async () => {
      vi.mocked(invoke).mockResolvedValueOnce({
        assetId: 'source-1',
        transcriptSegmentCount: 3,
        speakerCount: 2,
        speakerTurnCount: 2,
      });

      const result = await globalToolRegistry.execute('import_external_diarization', {
        assetId: 'source-1',
        inputPath: '/tmp/diarization.json',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.assetId).toBe('source-1');
      expect(data.speakerCount).toBe(2);
      expect(data.speakerTurnCount).toBe(2);
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('import_diarization_json', {
        assetId: 'source-1',
        inputPath: '/tmp/diarization.json',
      });
    });
  });

  describe('run_external_diarization', () => {
    it('should run external diarization and return import summary', async () => {
      vi.mocked(invoke).mockResolvedValueOnce({
        assetId: 'source-1',
        inputAudioPath: '/tmp/in.wav',
        outputJsonPath: '/tmp/out.json',
        transcriptSegmentCount: 3,
        speakerCount: 2,
        speakerTurnCount: 2,
      });

      const result = await globalToolRegistry.execute('run_external_diarization', {
        assetId: 'source-1',
        executable: '/usr/bin/python',
        args: ['runner.py', '--input', '{audioPath}', '--output', '{outputPath}'],
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.assetId).toBe('source-1');
      expect(data.speakerCount).toBe(2);
      expect(vi.mocked(invoke)).toHaveBeenCalledWith('run_external_diarization', {
        assetId: 'source-1',
        executable: '/usr/bin/python',
        args: ['runner.py', '--input', '{audioPath}', '--output', '{outputPath}'],
      });
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

    it('should search visual breakdown entries when requested', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'search-visual',
            name: 'visual.mp4',
            kind: 'video',
            uri: '/media/visual.mp4',
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
          assetId: 'search-visual',
          shots: [
            {
              startSec: 0,
              endSec: 6,
              confidence: 0.9,
              keyframePath: 'shots/0001.jpg',
              keyframeSelectionMethod: 'thumbnail',
            },
          ],
          transcript: [],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18.2],
            peakDb: -4,
            silenceRegions: [],
          },
          segments: [
            { startSec: 0, endSec: 6, segmentType: 'performance', confidence: 0.9, features: {} },
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
        assetId: 'search-visual',
        query: 'wide static center',
        sections: ['visual'],
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBeGreaterThan(0);
      expect(data.matches[0].sectionType).toBe('visual');
      expect(data.matches[0].whyMatched).toContain('cameraAngle');
      expect(data.matches[0].keyframePath).toBe('shots/0001.jpg');
      expect(String(data.matches[0].preview)).toContain('wide angle');
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

    it('should analyze missing bundles when analyzeMissing is enabled', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'lib-analyze',
            name: 'analyze.mp4',
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
        .mockResolvedValueOnce({
          assetId: 'lib-analyze',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/a.jpg' }],
          transcript: [
            {
              startSec: 0,
              endSec: 2,
              text: 'Interview answer quote',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
              speakerTurnId: 'turn_001',
            },
          ],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18],
            peakDb: -4,
            silenceRegions: [],
            speechRegions: [{ startSec: 0, endSec: 4 }],
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
        query: 'answer quote',
        analyzeMissing: true,
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBeGreaterThan(0);
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, 'get_analysis_bundle', {
        assetId: 'lib-analyze',
      });
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, 'analyze_video_full', {
        assetId: 'lib-analyze',
        options: {
          shots: true,
          transcript: true,
          audio: true,
          segments: true,
          visual: true,
          localOnly: false,
        },
      });
    });

    it('should return skipped asset details when an asset fails during library search', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'lib-bad',
            name: 'bad.mp4',
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

      vi.mocked(invoke).mockRejectedValueOnce(new Error('analysis backend unavailable'));

      const result = await globalToolRegistry.execute('search_source_library', {
        query: 'anything',
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBe(0);
      expect(data.skippedAssetCount).toBe(1);
      expect(data.skippedAssets).toEqual([
        {
          assetId: 'lib-bad',
          assetName: 'bad.mp4',
          reason: 'analysis backend unavailable',
        },
      ]);
    });
  });

  // ===========================================================================
  // search_indexed_source_library
  // ===========================================================================

  describe('search_indexed_source_library', () => {
    it('should index report chunks and return indexed matches', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'idx-1',
            name: 'indexed.mp4',
            kind: 'video',
            uri: '/media/indexed.mp4',
            durationSec: 8,
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
          assetId: 'idx-1',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [
            {
              startSec: 0,
              endSec: 3,
              text: 'Best answer quote here',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
              speakerTurnId: 'turn_001',
            },
          ],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18],
            peakDb: -4,
            silenceRegions: [],
            speechRegions: [{ startSec: 0, endSec: 4 }],
          },
          segments: [
            { startSec: 0, endSec: 4, segmentType: 'talk', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          contactSheet: null,
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
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          total: 1,
          processingTimeMs: 2,
          results: [
            {
              chunkId: 'idx-1:speakerTurns:0',
              assetId: 'idx-1',
              sectionType: 'speakerTurns',
              sectionIndex: 0,
              startSec: 0,
              endSec: 3,
              score: 0.72,
              searchText: 'best answer quote spoken content',
              metadata: {
                preview: 'speaker_1 - Best answer quote here',
                audioCue: 'speech-heavy',
                durationSec: 3,
                speakerId: 'speaker_1',
                wordCount: 4,
                segmentCount: 1,
                dominantSegmentType: 'talk',
              },
            },
          ],
        });

      const result = await globalToolRegistry.execute('search_indexed_source_library', {
        query: 'best answer quote',
        sections: ['speakerTurns'],
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.retrievalMode).toBe('indexedChunks');
      expect(data.count).toBe(1);
      expect(data.matches[0].sectionType).toBe('speakerTurns');
      expect(data.matches[0].rankingNotes).toContain('dialogue query prefers speaker turns');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(3, 'index_source_report_chunks', {
        assetId: 'idx-1',
        chunks: expect.arrayContaining([
          expect.objectContaining({
            sectionType: 'speakerTurns',
          }),
        ]),
      });
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(4, 'search_source_report_chunks', {
        query: {
          query: 'best answer quote',
          assetIds: ['idx-1'],
          sections: ['speakerTurns'],
          limit: 40,
          useSemantic: false,
        },
      });
    });

    it('should pass semantic mode to backend indexed retrieval when requested', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'idx-semantic',
            name: 'semantic.mp4',
            kind: 'video',
            uri: '/media/semantic.mp4',
            durationSec: 8,
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
          assetId: 'idx-semantic',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18],
            peakDb: -4,
            silenceRegions: [],
            speechRegions: [{ startSec: 0, endSec: 4 }],
          },
          segments: [],
          frameAnalysis: [],
          contactSheet: null,
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
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ total: 0, processingTimeMs: 2, results: [] })
        .mockResolvedValueOnce([]);

      await globalToolRegistry.execute('search_indexed_source_library', {
        query: 'semantic retrieval',
        useSemantic: true,
      });

      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(4, 'search_source_report_chunks', {
        query: {
          query: 'semantic retrieval',
          assetIds: ['idx-semantic'],
          sections: ['moments', 'chapters', 'highlights', 'speakerTurns', 'visual'],
          limit: 40,
          useSemantic: true,
        },
      });
    });

    it('should index visual chunks for visual retrieval', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'idx-visual',
            name: 'visual-indexed.mp4',
            kind: 'video',
            uri: '/media/visual-indexed.mp4',
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
          assetId: 'idx-visual',
          shots: [
            {
              startSec: 0,
              endSec: 6,
              confidence: 0.9,
              keyframePath: 'shots/0001.jpg',
              keyframeSelectionMethod: 'thumbnail',
            },
          ],
          transcript: [],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18],
            peakDb: -4,
            silenceRegions: [],
            speechRegions: [{ startSec: 0, endSec: 6 }],
          },
          segments: [],
          frameAnalysis: [
            {
              shotIndex: 0,
              cameraAngle: 'wide',
              subjectPosition: 'center',
              motionDirection: 'static',
              visualComplexity: 0.42,
            },
          ],
          contactSheet: null,
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
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          total: 1,
          processingTimeMs: 2,
          results: [
            {
              chunkId: 'idx-visual:visual:0',
              assetId: 'idx-visual',
              sectionType: 'visual',
              sectionIndex: 0,
              startSec: 0,
              endSec: 6,
              score: 0.8,
              searchText: 'wide center static shot 1 complexity 0.42',
              metadata: {
                preview: 'Shot 1 | wide angle | center subject | static motion | complexity 0.42',
                keyframePath: 'shots/0001.jpg',
                cameraAngle: 'wide',
                subjectPosition: 'center',
                motionDirection: 'static',
                durationSec: 6,
              },
            },
          ],
        })
        .mockResolvedValueOnce([]);

      const result = await globalToolRegistry.execute('search_indexed_source_library', {
        query: 'wide static shot',
        sections: ['visual'],
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBe(1);
      expect(data.matches[0].sectionType).toBe('visual');
      expect(data.matches[0].keyframePath).toBe('shots/0001.jpg');
      expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(3, 'index_source_report_chunks', {
        assetId: 'idx-visual',
        chunks: expect.arrayContaining([
          expect.objectContaining({
            sectionType: 'visual',
            metadata: expect.objectContaining({
              keyframePath: 'shots/0001.jpg',
              cameraAngle: 'wide',
            }),
          }),
        ]),
      });
    });

    it('should boost indexed matches that were previously selected in memory', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'idx-memory',
            name: 'memory.mp4',
            kind: 'video',
            uri: '/media/memory.mp4',
            durationSec: 8,
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
          assetId: 'idx-memory',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [
            {
              startSec: 0,
              endSec: 3,
              text: 'Best answer quote here',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
              speakerTurnId: 'turn_001',
            },
          ],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18],
            peakDb: -4,
            silenceRegions: [],
            speechRegions: [{ startSec: 0, endSec: 4 }],
          },
          segments: [
            { startSec: 0, endSec: 4, segmentType: 'talk', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          contactSheet: null,
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
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          total: 1,
          processingTimeMs: 2,
          results: [
            {
              chunkId: 'idx-memory:speakerTurns:0',
              assetId: 'idx-memory',
              sectionType: 'speakerTurns',
              sectionIndex: 0,
              startSec: 0,
              endSec: 3,
              score: 0.72,
              searchText: 'best answer quote spoken content',
              metadata: {
                preview: 'speaker_1 - Best answer quote here',
                audioCue: 'speech-heavy',
                durationSec: 3,
                speakerId: 'speaker_1',
                wordCount: 4,
                segmentCount: 1,
                dominantSegmentType: 'talk',
              },
            },
          ],
        })
        .mockResolvedValueOnce([
          {
            key: 'idx-memory:speakerTurns:0',
            value: JSON.stringify({
              assetId: 'idx-memory',
              sectionType: 'speakerTurns',
              sectionIndex: 0,
              startSec: 0,
              endSec: 3,
              query: 'best answer quote',
              selectedAt: new Date().toISOString(),
            }),
            updatedAt: Date.now(),
          },
        ]);

      const result = await globalToolRegistry.execute('search_indexed_source_library', {
        query: 'best answer quote',
        sections: ['speakerTurns'],
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.memoryEntryCount).toBe(1);
      expect(data.matches[0].rankingNotes).toContain('memory boost: exact chunk selected before');
      expect(data.matches[0].score).toBeGreaterThan(data.matches[0].rawScore);
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

    it('should support indexed retrieval for selects building', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'select-indexed',
            name: 'indexed-selects.mp4',
            kind: 'video',
            uri: '/media/indexed-selects.mp4',
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
          assetId: 'select-indexed',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [
            {
              startSec: 0,
              endSec: 3,
              text: 'Best answer quote here',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
              speakerTurnId: 'turn_001',
            },
          ],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18],
            peakDb: -4,
            silenceRegions: [],
            speechRegions: [{ startSec: 0, endSec: 4 }],
          },
          segments: [
            { startSec: 0, endSec: 4, segmentType: 'talk', confidence: 0.9, features: {} },
          ],
          frameAnalysis: [],
          contactSheet: null,
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
        .mockResolvedValueOnce({ annotation: null, status: 'notAnalyzed' })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          total: 1,
          processingTimeMs: 2,
          results: [
            {
              chunkId: 'select-indexed:speakerTurns:0',
              assetId: 'select-indexed',
              sectionType: 'speakerTurns',
              sectionIndex: 0,
              startSec: 0,
              endSec: 3,
              score: 0.72,
              searchText: 'best answer quote spoken content',
              metadata: {
                preview: 'speaker_1 - Best answer quote here',
                audioCue: 'speech-heavy',
                durationSec: 3,
                speakerId: 'speaker_1',
                wordCount: 4,
                segmentCount: 1,
                dominantSegmentType: 'talk',
              },
            },
          ],
        })
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(undefined);

      const result = await globalToolRegistry.execute('build_source_selects', {
        query: 'best answer quote',
        useIndexedSearch: true,
        sections: ['speakerTurns'],
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBe(1);
      expect(data.selects[0].sectionType).toBe('speakerTurns');
      expect(data.selects[0].rankingNotes).toContain('dialogue query prefers speaker turns');
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

    it('should not create an empty selects track when apply is requested with no matches', async () => {
      const executeCommandMock = vi.fn();

      setupStores({
        assets: [
          createAsset({
            id: 'select-empty',
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
      useProjectStore.setState({
        executeCommand: executeCommandMock,
      } as unknown as Parameters<typeof useProjectStore.setState>[0]);

      vi.mocked(invoke)
        .mockResolvedValueOnce({
          assetId: 'select-empty',
          shots: [],
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
        query: 'no matching moments',
        apply: true,
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.count).toBe(0);
      expect(data.applied).toMatchObject({
        sequenceId: 'seq_001',
        trackId: null,
        createdTrack: false,
        insertedClipCount: 0,
      });
      expect(executeCommandMock).not.toHaveBeenCalled();
    });

    it('should apply selects onto an existing track when apply is enabled', async () => {
      setupStores({
        sequences: [
          createMockSequence({
            id: 'seq_001',
            name: 'Test Sequence',
            tracks: [createTrack({ id: 'selects-track', name: 'Source Selects', clips: [] })],
          }),
        ],
        assets: [
          createAsset({
            id: 'select-apply',
            name: 'apply.mp4',
            kind: 'video',
            uri: '/media/apply.mp4',
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
          assetId: 'select-apply',
          shots: [{ startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' }],
          transcript: [
            {
              startSec: 0.5,
              endSec: 2.5,
              text: 'Best answer quote here',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
              speakerTurnId: 'turn_001',
            },
          ],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18],
            peakDb: -4,
            silenceRegions: [],
            speechRegions: [{ startSec: 0, endSec: 4 }],
          },
          segments: [
            { startSec: 0, endSec: 4, segmentType: 'talk', confidence: 0.9, features: {} },
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

      vi.mocked(executeAgentCommand).mockResolvedValue({
        opId: 'op-insert',
        changes: [],
        createdIds: ['clip-created-1'],
        deletedIds: [],
      });

      const result = await globalToolRegistry.execute('build_source_selects', {
        query: 'best answer quote',
        sections: ['moments'],
        apply: true,
      });

      const data = getToolResult<Record<string, any>>(result);
      expect(data.applied).toMatchObject({
        sequenceId: 'seq_001',
        trackId: 'selects-track',
        createdTrack: false,
        insertedClipCount: 1,
      });
      expect(vi.mocked(executeAgentCommand)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(executeAgentCommand)).toHaveBeenCalledWith('InsertClip', {
        sequenceId: 'seq_001',
        trackId: 'selects-track',
        assetId: 'select-apply',
        timelineStart: 0,
        sourceIn: 0,
        sourceOut: 4.25,
      });
    });

    it('should roll back inserted clips and created track when apply fails mid-flight', async () => {
      setupStores({
        assets: [
          createAsset({
            id: 'select-rollback',
            name: 'rollback.mp4',
            kind: 'video',
            uri: '/media/rollback.mp4',
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
          assetId: 'select-rollback',
          shots: [
            { startSec: 0, endSec: 4, confidence: 0.9, keyframePath: 'shots/0001.jpg' },
            { startSec: 4, endSec: 8, confidence: 0.9, keyframePath: 'shots/0002.jpg' },
          ],
          transcript: [
            {
              startSec: 0.5,
              endSec: 2.5,
              text: 'Best answer quote here',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_1',
              speakerTurnId: 'turn_001',
            },
            {
              startSec: 4.5,
              endSec: 6.5,
              text: 'Another answer quote here',
              confidence: 0.95,
              language: 'en',
              speakerId: 'speaker_2',
              speakerTurnId: 'turn_002',
            },
          ],
          audioProfile: {
            bpm: 100,
            spectralCentroidHz: 1000,
            loudnessProfile: [-18],
            peakDb: -4,
            silenceRegions: [],
            speechRegions: [
              { startSec: 0, endSec: 4 },
              { startSec: 4, endSec: 8 },
            ],
          },
          segments: [
            { startSec: 0, endSec: 4, segmentType: 'talk', confidence: 0.9, features: {} },
            { startSec: 4, endSec: 8, segmentType: 'talk', confidence: 0.9, features: {} },
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

      vi.mocked(executeAgentCommand)
        .mockResolvedValueOnce({
          opId: 'op-create-track',
          changes: [],
          createdIds: ['new-track-id'],
          deletedIds: [],
        })
        .mockResolvedValueOnce({
          opId: 'op-insert-1',
          changes: [],
          createdIds: ['clip-created-1'],
          deletedIds: [],
        })
        .mockRejectedValueOnce(new Error('InsertClip exploded'))
        .mockResolvedValueOnce({
          opId: 'op-delete-1',
          changes: [],
          createdIds: [],
          deletedIds: ['clip-created-1'],
        })
        .mockResolvedValueOnce({
          opId: 'op-remove-track',
          changes: [],
          createdIds: [],
          deletedIds: ['new-track-id'],
        });

      const result = await globalToolRegistry.execute('build_source_selects', {
        query: 'best answer quote',
        sections: ['speakerTurns'],
        limit: 2,
        apply: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('InsertClip exploded');
      expect(vi.mocked(executeAgentCommand).mock.calls.map(([name]) => name)).toEqual([
        'CreateTrack',
        'InsertClip',
        'InsertClip',
        'RemoveClip',
        'RemoveTrack',
      ]);
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

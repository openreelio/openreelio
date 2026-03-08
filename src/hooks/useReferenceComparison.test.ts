/**
 * useReferenceComparison Hook Tests
 *
 * Tests for loading an ESD document and computing comparison metrics
 * between reference pacing/transitions and the current timeline output.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useProjectStore } from '@/stores/projectStore';
import type { EditingStyleDocument, Sequence } from '@/bindings';
import type { Sequence as StoreSequence } from '@/types';

// =============================================================================
// Bindings Mock (external boundary: Tauri IPC)
// =============================================================================

vi.mock('@/bindings', () => ({
  commands: {
    getEsd: vi.fn(),
    listEsds: vi.fn(),
  },
}));

import { commands } from '@/bindings';
import { useReferenceComparison } from './useReferenceComparison';

// =============================================================================
// Test Data Helpers
// =============================================================================

function createMockEsd(overrides?: Partial<EditingStyleDocument>): EditingStyleDocument {
  return {
    id: 'esd-1',
    name: 'Test ESD',
    sourceAssetId: 'asset-1',
    createdAt: '2026-03-07T00:00:00Z',
    version: '1.0',
    rhythmProfile: {
      shotDurations: [2, 3, 1, 4],
      meanDuration: 2.5,
      medianDuration: 2.5,
      stdDeviation: 1.1,
      minDuration: 1,
      maxDuration: 4,
      tempoClassification: 'moderate',
    },
    transitionInventory: {
      transitions: [],
      typeFrequency: { cut: 3, dissolve: 1 },
      dominantType: 'cut',
    },
    pacingCurve: [
      { normalizedPosition: 0.25, normalizedDuration: 0.5 },
      { normalizedPosition: 0.75, normalizedDuration: 0.8 },
    ],
    syncPoints: [],
    contentMap: [],
    cameraPatterns: [],
    ...overrides,
  } as EditingStyleDocument;
}

function createMockSequence(overrides?: Partial<Sequence>): Sequence {
  return {
    id: 'seq-1',
    name: 'Test Sequence',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
    },
    tracks: [
      {
        id: 'track-v1',
        kind: 'video',
        name: 'Video 1',
        clips: [
          {
            id: 'clip-1',
            assetId: 'asset-1',
            range: { sourceInSec: 0, sourceOutSec: 3 },
            place: { timelineInSec: 0, durationSec: 3 },
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
            opacity: 1,
            blendMode: 'normal',
            speed: 1,
            reverse: false,
            effects: [],
          },
          {
            id: 'clip-2',
            assetId: 'asset-2',
            range: { sourceInSec: 0, sourceOutSec: 5 },
            place: { timelineInSec: 3, durationSec: 5 },
            transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
            opacity: 1,
            blendMode: 'normal',
            speed: 1,
            reverse: false,
            effects: [],
          },
        ],
        blendMode: 'normal',
        muted: false,
        locked: false,
        visible: true,
      },
    ],
    markers: [],
    createdAt: '2026-03-07T00:00:00Z',
    modifiedAt: '2026-03-07T00:00:00Z',
    ...overrides,
  } as unknown as Sequence;
}

// =============================================================================
// Tests
// =============================================================================

describe('useReferenceComparison', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.listEsds).mockResolvedValue({ status: 'ok', data: [] });

    // Reset project store to clean state
    useProjectStore.setState({
      activeSequenceId: null,
      sequences: new Map(),
    });
  });

  // ===========================================================================
  // Initial / empty state
  // ===========================================================================

  describe('initial state', () => {
    it('should return empty state when no ESD exists in the project', async () => {
      const { result } = renderHook(() => useReferenceComparison());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.esd).toBeNull();
      expect(result.current.error).toBeNull();
      expect(result.current.referenceCurve).toEqual([]);
      expect(result.current.outputCurve).toEqual([]);
      expect(result.current.outputStructure).toEqual([]);
      expect(result.current.correlation).toBe(0);
      expect(result.current.transitionDiffs).toEqual([]);
    });

    it('should look up the latest ESD when no esdId is provided', async () => {
      renderHook(() => useReferenceComparison());

      await waitFor(() => {
        expect(commands.listEsds).toHaveBeenCalledTimes(1);
      });
      expect(commands.getEsd).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Loading ESD
  // ===========================================================================

  describe('loading ESD', () => {
    it('should load ESD when esdId is provided', async () => {
      const mockEsd = createMockEsd();
      vi.mocked(commands.getEsd).mockResolvedValue({
        status: 'ok',
        data: mockEsd,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      // Should be loading initially
      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.esd).not.toBeNull();
      expect(result.current.esd?.id).toBe('esd-1');
      expect(result.current.error).toBeNull();
    });

    it('should derive reference curve from ESD pacing points', async () => {
      const mockEsd = createMockEsd();
      vi.mocked(commands.getEsd).mockResolvedValue({
        status: 'ok',
        data: mockEsd,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.esd).not.toBeNull();
      });

      // Pacing curve should be mapped from normalizedPosition -> time, normalizedDuration -> value
      expect(result.current.referenceCurve).toEqual([
        { time: 0.25, value: 0.5 },
        { time: 0.75, value: 0.8 },
      ]);
    });

    it('should load the newest ESD when esdId is omitted', async () => {
      const mockEsd = createMockEsd({ id: 'esd-latest' });
      vi.mocked(commands.listEsds).mockResolvedValue({
        status: 'ok',
        data: [
          {
            id: 'esd-older',
            name: 'Older',
            sourceAssetId: 'asset-1',
            createdAt: '2026-03-06T00:00:00Z',
            tempoClassification: 'slow',
          },
          {
            id: 'esd-latest',
            name: 'Latest',
            sourceAssetId: 'asset-2',
            createdAt: '2026-03-08T00:00:00Z',
            tempoClassification: 'fast',
          },
        ],
      });
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      const { result } = renderHook(() => useReferenceComparison());

      await waitFor(() => {
        expect(result.current.esd?.id).toBe('esd-latest');
      });

      expect(commands.getEsd).toHaveBeenCalledWith('esd-latest');
    });

    it('should build transition diffs from ESD inventory', async () => {
      const mockEsd = createMockEsd();
      vi.mocked(commands.getEsd).mockResolvedValue({
        status: 'ok',
        data: mockEsd,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.esd).not.toBeNull();
      });

      // Without active sequence, output clip count is 0
      // cut: ref=3, output=0 (no clips - 1 = 0); dissolve: ref=1, output=0
      expect(result.current.transitionDiffs.length).toBeGreaterThan(0);
      const cutRow = result.current.transitionDiffs.find((r) => r.type === 'cut');
      expect(cutRow).toBeDefined();
      expect(cutRow!.referenceCount).toBe(3);
    });
  });

  // ===========================================================================
  // Error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should handle IPC error from getEsd', async () => {
      vi.mocked(commands.getEsd).mockResolvedValue({
        status: 'error',
        error: 'Database connection failed',
      });

      const { result } = renderHook(() => useReferenceComparison('bad-id'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Database connection failed');
      expect(result.current.esd).toBeNull();
    });

    it('should handle exception from getEsd', async () => {
      vi.mocked(commands.getEsd).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useReferenceComparison('bad-id'));

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.esd).toBeNull();
    });

    it('should set error when ESD is not found (ok but null data)', async () => {
      vi.mocked(commands.getEsd).mockResolvedValue({
        status: 'ok',
        data: null,
      });

      const { result } = renderHook(() => useReferenceComparison('nonexistent'));

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toContain('not found');
      expect(result.current.esd).toBeNull();
    });
  });

  // ===========================================================================
  // esdId change
  // ===========================================================================

  describe('esdId changes', () => {
    it('should load new ESD when esdId changes', async () => {
      const esd1 = createMockEsd({ id: 'esd-1', name: 'First' });
      const esd2 = createMockEsd({ id: 'esd-2', name: 'Second' });

      vi.mocked(commands.getEsd)
        .mockResolvedValueOnce({ status: 'ok', data: esd1 })
        .mockResolvedValueOnce({ status: 'ok', data: esd2 });

      const { result, rerender } = renderHook(
        ({ esdId }: { esdId?: string }) => useReferenceComparison(esdId),
        { initialProps: { esdId: 'esd-1' } },
      );

      await waitFor(() => {
        expect(result.current.esd?.id).toBe('esd-1');
      });

      rerender({ esdId: 'esd-2' });

      await waitFor(() => {
        expect(result.current.esd?.id).toBe('esd-2');
      });

      expect(commands.getEsd).toHaveBeenCalledTimes(2);
    });

    it('should clear ESD when esdId becomes undefined', async () => {
      const esd = createMockEsd();
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: esd });

      const { result, rerender } = renderHook(
        ({ esdId }: { esdId?: string }) => useReferenceComparison(esdId),
        { initialProps: { esdId: 'esd-1' } as { esdId?: string } },
      );

      await waitFor(() => {
        expect(result.current.esd).not.toBeNull();
      });

      rerender({});

      await waitFor(() => {
        expect(result.current.esd).toBeNull();
      });
      expect(result.current.error).toBeNull();
    });
  });

  // ===========================================================================
  // Output curve from timeline
  // ===========================================================================

  describe('output curve from timeline', () => {
    it('should derive output curve from active sequence clips', async () => {
      const mockEsd = createMockEsd();
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      const seq = createMockSequence();
      useProjectStore.setState({
        activeSequenceId: 'seq-1',
        sequences: new Map([['seq-1', seq]]) as unknown as Map<string, StoreSequence>,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      // Wait for ESD to load
      await waitFor(() => {
        expect(result.current.esd).not.toBeNull();
      });

      // Wait for debounce (300ms) to settle

      // Two video clips: clip-1 (0-3s, center=1.5), clip-2 (3-8s, center=5.5)
      // Total extent = 8. Normalized: clip-1 time=1.5/8=0.1875, clip-2 time=5.5/8=0.6875
      await waitFor(() => {
        expect(result.current.outputCurve.length).toBe(2);
      });

      expect(result.current.outputCurve[0].value).toBe(3); // clip-1 duration
      expect(result.current.outputCurve[1].value).toBe(5); // clip-2 duration
    });

    it('should build output structure segments from the primary track', async () => {
      const mockEsd = createMockEsd({
        contentMap: [
          { startSec: 0, endSec: 4, segmentType: 'talk', confidence: 0.9 },
          { startSec: 4, endSec: 8, segmentType: 'montage', confidence: 0.8 },
        ] as EditingStyleDocument['contentMap'],
      });
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      const seq = createMockSequence();
      useProjectStore.setState({
        activeSequenceId: 'seq-1',
        sequences: new Map([['seq-1', seq]]) as unknown as Map<string, StoreSequence>,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.outputStructure.length).toBe(2);
      });

      expect(result.current.outputStructure[0].segmentType).toBe('talk');
      expect(result.current.outputStructure[1].segmentType).toBe('montage');
    });

    it('should return empty output curve when no active sequence', async () => {
      const mockEsd = createMockEsd();
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.esd).not.toBeNull();
      });

      expect(result.current.outputCurve).toEqual([]);
    });

    it('should only consider video track clips for output curve', async () => {
      const mockEsd = createMockEsd();
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      const seq = createMockSequence({
        tracks: [
          {
            id: 'track-v1',
            kind: 'video',
            name: 'Video 1',
            clips: [
              {
                id: 'clip-v1',
                assetId: 'a1',
                range: { sourceInSec: 0, sourceOutSec: 2 },
                place: { timelineInSec: 0, durationSec: 2 },
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                opacity: 1,
                blendMode: 'normal',
                speed: 1,
                reverse: false,
                effects: [],
              },
            ],
            blendMode: 'normal',
            muted: false,
            locked: false,
            visible: true,
          },
          {
            id: 'track-a1',
            kind: 'audio',
            name: 'Audio 1',
            clips: [
              {
                id: 'clip-a1',
                assetId: 'a2',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 0, durationSec: 10 },
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                opacity: 1,
                blendMode: 'normal',
                speed: 1,
                reverse: false,
                effects: [],
              },
            ],
            blendMode: 'normal',
            muted: false,
            locked: false,
            visible: true,
          },
        ] as unknown as Sequence['tracks'],
      });

      useProjectStore.setState({
        activeSequenceId: 'seq-1',
        sequences: new Map([['seq-1', seq]]) as unknown as Map<string, StoreSequence>,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.esd).not.toBeNull();
      });

      // Wait for debounce to settle
      await waitFor(() => {
        expect(result.current.outputCurve.length).toBe(1); // Only video clip
      });
    });
  });

  // ===========================================================================
  // Correlation
  // ===========================================================================

  describe('correlation computation', () => {
    it('should return 0 correlation when output curve is empty', async () => {
      const mockEsd = createMockEsd();
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.esd).not.toBeNull();
      });

      expect(result.current.correlation).toBe(0);
    });

    it('should return 0 correlation when reference curve is empty', async () => {
      const mockEsd = createMockEsd({ pacingCurve: [] });
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      const seq = createMockSequence();
      useProjectStore.setState({
        activeSequenceId: 'seq-1',
        sequences: new Map([['seq-1', seq]]) as unknown as Map<string, StoreSequence>,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.esd).not.toBeNull();
      });

      expect(result.current.correlation).toBe(0);
    });

    it('should preserve negative correlation for inverse pacing', async () => {
      const mockEsd = createMockEsd({
        pacingCurve: [
          { normalizedPosition: 0.2, normalizedDuration: 1 },
          { normalizedPosition: 0.4, normalizedDuration: 2 },
          { normalizedPosition: 0.6, normalizedDuration: 3 },
        ],
      });
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      const seq = createMockSequence({
        tracks: [
          {
            id: 'track-v1',
            kind: 'video',
            name: 'Video 1',
            clips: [
              {
                id: 'clip-1',
                assetId: 'asset-1',
                range: { sourceInSec: 0, sourceOutSec: 3 },
                place: { timelineInSec: 0, durationSec: 3 },
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                opacity: 1,
                blendMode: 'normal',
                speed: 1,
                reverse: false,
                effects: [],
              },
              {
                id: 'clip-2',
                assetId: 'asset-2',
                range: { sourceInSec: 0, sourceOutSec: 2 },
                place: { timelineInSec: 3, durationSec: 2 },
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                opacity: 1,
                blendMode: 'normal',
                speed: 1,
                reverse: false,
                effects: [],
              },
              {
                id: 'clip-3',
                assetId: 'asset-3',
                range: { sourceInSec: 0, sourceOutSec: 1 },
                place: { timelineInSec: 5, durationSec: 1 },
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                opacity: 1,
                blendMode: 'normal',
                speed: 1,
                reverse: false,
                effects: [],
              },
            ] as unknown as Sequence['tracks'][number]['clips'],
            blendMode: 'normal',
            muted: false,
            locked: false,
            visible: true,
          },
        ] as unknown as Sequence['tracks'],
      });
      useProjectStore.setState({
        activeSequenceId: 'seq-1',
        sequences: new Map([['seq-1', seq]]) as unknown as Map<string, StoreSequence>,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.outputCurve.length).toBe(3);
      });

      expect(result.current.correlation).toBeLessThan(0);
    });
  });

  // ===========================================================================
  // Transition diffs with active sequence
  // ===========================================================================

  describe('transition diffs with clips', () => {
    it('should compute output cut count from clip count', async () => {
      const mockEsd = createMockEsd({
        transitionInventory: {
          transitions: [],
          typeFrequency: { cut: 5 },
          dominantType: 'cut',
        },
      });
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      // Sequence with 3 video clips => 2 transitions (cuts)
      const seq = createMockSequence({
        tracks: [
          {
            id: 'track-v1',
            kind: 'video',
            name: 'V1',
            clips: [
              {
                id: 'c1',
                assetId: 'a1',
                range: { sourceInSec: 0, sourceOutSec: 2 },
                place: { timelineInSec: 0, durationSec: 2 },
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                opacity: 1,
                blendMode: 'normal',
                speed: 1,
                reverse: false,
                effects: [],
              },
              {
                id: 'c2',
                assetId: 'a2',
                range: { sourceInSec: 0, sourceOutSec: 2 },
                place: { timelineInSec: 2, durationSec: 2 },
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                opacity: 1,
                blendMode: 'normal',
                speed: 1,
                reverse: false,
                effects: [],
              },
              {
                id: 'c3',
                assetId: 'a3',
                range: { sourceInSec: 0, sourceOutSec: 2 },
                place: { timelineInSec: 4, durationSec: 2 },
                transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
                opacity: 1,
                blendMode: 'normal',
                speed: 1,
                reverse: false,
                effects: [],
              },
            ] as unknown as Sequence['tracks'][number]['clips'],
            blendMode: 'normal',
            muted: false,
            locked: false,
            visible: true,
          },
        ] as unknown as Sequence['tracks'],
      });

      useProjectStore.setState({
        activeSequenceId: 'seq-1',
        sequences: new Map([['seq-1', seq]]) as unknown as Map<string, StoreSequence>,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.esd).not.toBeNull();
      });

      // Wait for debounce to settle
      await waitFor(() => {
        expect(result.current.transitionDiffs.length).toBeGreaterThan(0);
      });

      const cutRow = result.current.transitionDiffs.find((r) => r.type === 'cut');
      expect(cutRow).toBeDefined();
      expect(cutRow!.referenceCount).toBe(5);
      // 3 clips - 1 = 2 output cuts
      expect(cutRow!.outputCount).toBe(2);
    });

    it('should include output-only cut rows when the reference has no cuts listed', async () => {
      const mockEsd = createMockEsd({
        transitionInventory: {
          transitions: [],
          typeFrequency: { dissolve: 1 },
          dominantType: 'dissolve',
        },
      });
      vi.mocked(commands.getEsd).mockResolvedValue({ status: 'ok', data: mockEsd });

      const seq = createMockSequence();
      useProjectStore.setState({
        activeSequenceId: 'seq-1',
        sequences: new Map([['seq-1', seq]]) as unknown as Map<string, StoreSequence>,
      });

      const { result } = renderHook(() => useReferenceComparison('esd-1'));

      await waitFor(() => {
        expect(result.current.transitionDiffs.length).toBeGreaterThan(1);
      });

      expect(result.current.transitionDiffs.find((row) => row.type === 'cut')?.outputCount).toBe(1);
    });
  });
});

/**
 * useCleanupDetection Hook Tests
 *
 * BDD-style integration tests for silence and filler word detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import {
  useCleanupDetection,
  DEFAULT_SILENCE_PARAMS,
  DEFAULT_PADDING_SEC,
} from '../useCleanupDetection';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import type { CleanupDetectionResult, DetectedRegion } from '@/types';

vi.mock('@/utils/stateRefreshHelper', () => ({
  refreshProjectState: vi.fn().mockResolvedValue({}),
  applyProjectState: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

// Helper: set up a selected clip in stores
function setupClipSelection(
  assetId = 'asset_1',
  clipRange: {
    sourceInSec: number;
    sourceOutSec: number;
    timelineInSec: number;
    durationSec: number;
  } = {
    sourceInSec: 0.0,
    sourceOutSec: 30.0,
    timelineInSec: 0.0,
    durationSec: 30.0,
  },
): void {
  const clipId = 'clip_1';
  const trackId = 'track_1';
  const seqId = 'seq_1';

  useTimelineStore.setState({ selectedClipIds: [clipId] });
  useProjectStore.setState({
    activeSequenceId: seqId,
    sequences: new Map([
      [
        seqId,
        {
          id: seqId,
          name: 'Test Sequence',
          tracks: [
            {
              id: trackId,
              kind: 'video',
              clips: [
                {
                  id: clipId,
                  assetId,
                  range: {
                    sourceInSec: clipRange.sourceInSec,
                    sourceOutSec: clipRange.sourceOutSec,
                  },
                  place: {
                    timelineInSec: clipRange.timelineInSec,
                    durationSec: clipRange.durationSec,
                  },
                  speed: 1.0,
                  effects: [],
                  audio: {},
                  transform: {},
                  opacity: 1.0,
                  blendMode: 'Normal',
                },
              ],
              name: 'Video 1',
              muted: false,
              locked: false,
              solo: false,
              volume: 1.0,
              pan: 0,
              height: 80,
            },
          ],
          format: { width: 1920, height: 1080, fps: 30 },
        } as any,
      ],
    ]),
  });
}

function createMockSilenceResult(count: number): CleanupDetectionResult {
  const regions: DetectedRegion[] = Array.from({ length: count }, (_, i) => ({
    startSec: i * 5 + 1,
    endSec: i * 5 + 2.5,
    regionType: 'silence' as const,
    label: 'silence',
  }));
  return {
    regions,
    count,
    totalDurationSec: count * 1.5,
  };
}

function createMockFillerResult(): CleanupDetectionResult {
  return {
    regions: [
      { startSec: 2.0, endSec: 2.5, regionType: 'filler_word', label: 'um' },
      { startSec: 7.0, endSec: 7.8, regionType: 'filler_word', label: 'you know' },
    ],
    count: 2,
    totalDurationSec: 1.3,
  };
}

describe('useCleanupDetection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTimelineStore.setState({ selectedClipIds: [] });
    useProjectStore.setState({ activeSequenceId: null, sequences: new Map() });
  });

  // ---------------------------------------------------------------------------
  // Feature: Initial State
  // ---------------------------------------------------------------------------

  describe('Initial State', () => {
    it('should have empty detection state when no operation performed', () => {
      const { result } = renderHook(() => useCleanupDetection());

      expect(result.current.detectedRegions).toEqual([]);
      expect(result.current.isDetecting).toBe(false);
      expect(result.current.isRemoving).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.mode).toBeNull();
      expect(result.current.totalDurationSec).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Feature: Silence Detection
  // ---------------------------------------------------------------------------

  describe('Silence Detection', () => {
    it('should detect silence regions with default params', async () => {
      setupClipSelection();
      const mockResult = createMockSilenceResult(3);
      mockInvoke.mockResolvedValueOnce(mockResult);

      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectSilence();
      });

      expect(mockInvoke).toHaveBeenCalledWith('detect_silence_regions', {
        args: {
          assetId: 'asset_1',
          thresholdDb: DEFAULT_SILENCE_PARAMS.thresholdDb,
          minDurationSec: DEFAULT_SILENCE_PARAMS.minDurationSec,
        },
      });
      expect(result.current.detectedRegions).toHaveLength(3);
      expect(result.current.mode).toBe('silence');
      expect(result.current.totalDurationSec).toBe(4.5);
      expect(result.current.error).toBeNull();
    });

    it('should detect silence with custom params', async () => {
      setupClipSelection();
      mockInvoke.mockResolvedValueOnce(createMockSilenceResult(1));

      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectSilence({ thresholdDb: -25, minDurationSec: 1.0 });
      });

      expect(mockInvoke).toHaveBeenCalledWith('detect_silence_regions', {
        args: {
          assetId: 'asset_1',
          thresholdDb: -25,
          minDurationSec: 1.0,
        },
      });
    });

    it('should constrain detected regions to the selected clip source range', async () => {
      setupClipSelection('asset_1', {
        sourceInSec: 10.0,
        sourceOutSec: 20.0,
        timelineInSec: 0.0,
        durationSec: 10.0,
      });
      mockInvoke.mockResolvedValueOnce({
        regions: [
          { startSec: 8.0, endSec: 11.0, regionType: 'silence', label: 'silence' },
          { startSec: 12.0, endSec: 13.0, regionType: 'silence', label: 'silence' },
          { startSec: 19.5, endSec: 22.0, regionType: 'silence', label: 'silence' },
        ],
        count: 3,
        totalDurationSec: 6.5,
      });

      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectSilence();
      });

      expect(result.current.detectedRegions).toEqual([
        { startSec: 10.0, endSec: 11.0, regionType: 'silence', label: 'silence' },
        { startSec: 12.0, endSec: 13.0, regionType: 'silence', label: 'silence' },
        { startSec: 19.5, endSec: 20.0, regionType: 'silence', label: 'silence' },
      ]);
      expect(result.current.totalDurationSec).toBe(2.5);
    });

    it('should set error when no clip is selected', async () => {
      // No clip selection setup
      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectSilence();
      });

      expect(result.current.error).toBe('No clip selected');
      expect(result.current.detectedRegions).toEqual([]);
    });

    it('should handle detection errors gracefully', async () => {
      setupClipSelection();
      mockInvoke.mockRejectedValueOnce(new Error('FFmpeg not found'));

      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectSilence();
      });

      expect(result.current.error).toBe('FFmpeg not found');
      expect(result.current.isDetecting).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Feature: Filler Word Detection
  // ---------------------------------------------------------------------------

  describe('Filler Word Detection', () => {
    it('should detect filler words with default list', async () => {
      setupClipSelection();
      const mockResult = createMockFillerResult();
      mockInvoke.mockResolvedValueOnce(mockResult);

      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectFillers();
      });

      expect(mockInvoke).toHaveBeenCalledWith('detect_filler_words', {
        args: {
          assetId: 'asset_1',
          customWords: [],
        },
      });
      expect(result.current.detectedRegions).toHaveLength(2);
      expect(result.current.mode).toBe('filler');
      expect(result.current.totalDurationSec).toBeCloseTo(1.3, 5);
    });

    it('should detect filler words with custom list', async () => {
      setupClipSelection();
      mockInvoke.mockResolvedValueOnce(createMockFillerResult());

      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectFillers(['um', 'uh', 'like']);
      });

      expect(mockInvoke).toHaveBeenCalledWith('detect_filler_words', {
        args: {
          assetId: 'asset_1',
          customWords: ['um', 'uh', 'like'],
        },
      });
    });

    it('should set error when no clip is selected for filler detection', async () => {
      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectFillers();
      });

      expect(result.current.error).toBe('No clip selected');
    });
  });

  // ---------------------------------------------------------------------------
  // Feature: Region Removal
  // ---------------------------------------------------------------------------

  describe('Region Removal', () => {
    it('should remove detected regions via IPC', async () => {
      setupClipSelection();
      const mockResult = createMockSilenceResult(2);
      mockInvoke.mockResolvedValueOnce(mockResult); // detect
      mockInvoke.mockResolvedValueOnce({ success: true, removedCount: 2 }); // remove

      const { result } = renderHook(() => useCleanupDetection());

      // First detect
      await act(async () => {
        await result.current.detectSilence();
      });
      expect(result.current.detectedRegions).toHaveLength(2);

      // Then remove
      await act(async () => {
        await result.current.removeDetected();
      });

      expect(mockInvoke).toHaveBeenCalledWith('remove_detected_regions', {
        args: expect.objectContaining({
          sequenceId: 'seq_1',
          trackId: 'track_1',
          clipId: 'clip_1',
          paddingSec: DEFAULT_PADDING_SEC,
        }),
      });
      // After removal, detection is cleared
      expect(result.current.detectedRegions).toEqual([]);
      expect(result.current.mode).toBeNull();
    });

    it('should error when removing with no detected regions', async () => {
      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.removeDetected();
      });

      expect(result.current.error).toBe('No regions detected to remove');
    });
  });

  // ---------------------------------------------------------------------------
  // Feature: Clear Detection
  // ---------------------------------------------------------------------------

  describe('Clear Detection', () => {
    it('should clear all detection state', async () => {
      setupClipSelection();
      mockInvoke.mockResolvedValueOnce(createMockSilenceResult(2));

      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectSilence();
      });
      expect(result.current.detectedRegions).toHaveLength(2);

      act(() => {
        result.current.clearDetection();
      });

      expect(result.current.detectedRegions).toEqual([]);
      expect(result.current.mode).toBeNull();
      expect(result.current.totalDurationSec).toBe(0);
      expect(result.current.error).toBeNull();
    });

    it('should clear detection when the selected clip changes', async () => {
      setupClipSelection();
      mockInvoke.mockResolvedValueOnce(createMockSilenceResult(2));

      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectSilence();
      });
      expect(result.current.detectedRegions).toHaveLength(2);

      act(() => {
        setupClipSelection('asset_2');
      });

      await waitFor(() => {
        expect(result.current.detectedRegions).toEqual([]);
      });
      expect(result.current.mode).toBeNull();
      expect(result.current.totalDurationSec).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Feature: Time-in-Region Check
  // ---------------------------------------------------------------------------

  describe('Time-in-Region Check', () => {
    it('should return true when time falls within a detected region', async () => {
      setupClipSelection();
      mockInvoke.mockResolvedValueOnce(createMockSilenceResult(1));

      const { result } = renderHook(() => useCleanupDetection());

      await act(async () => {
        await result.current.detectSilence();
      });

      // Region is at 1.0 - 2.5
      expect(result.current.isTimeInDetectedRegion(1.5)).toBe(true);
      expect(result.current.isTimeInDetectedRegion(0.5)).toBe(false);
      expect(result.current.isTimeInDetectedRegion(3.0)).toBe(false);
    });

    it('should return false when no regions detected', () => {
      const { result } = renderHook(() => useCleanupDetection());
      expect(result.current.isTimeInDetectedRegion(1.0)).toBe(false);
    });
  });
});

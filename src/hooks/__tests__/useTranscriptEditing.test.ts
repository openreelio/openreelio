/**
 * useTranscriptEditing Hook Tests
 *
 * BDD-style integration tests for transcript-driven editing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useTranscriptEditing, type TranscriptWord } from '../useTranscriptEditing';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { refreshProjectState } from '@/utils/stateRefreshHelper';

vi.mock('@/utils/stateRefreshHelper', () => ({
  refreshProjectState: vi.fn().mockResolvedValue({
    assets: new Map(),
    sequences: new Map(),
    effects: new Map(),
    activeSequenceId: null,
  }),
  applyProjectState: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

// Helper: create mock words
function createMockWords(count: number): TranscriptWord[] {
  return Array.from({ length: count }, (_, i) => ({
    text: `word${i}`,
    startSec: i * 1.0,
    endSec: (i + 1) * 1.0,
    segmentIndex: Math.floor(i / 3),
    wordIndex: i % 3,
    confidence: 0.95,
    speakerId: null,
  }));
}

// Helper: set up a selected clip in stores
function setupClipSelection(assetId = 'asset_1'): void {
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
                  range: { sourceInSec: 0.0, sourceOutSec: 10.0 },
                  place: { timelineInSec: 0.0, durationSec: 10.0 },
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

describe('useTranscriptEditing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTimelineStore.setState({ selectedClipIds: [] });
    useProjectStore.setState({ activeSequenceId: null, sequences: new Map() });
    usePlaybackStore.setState({ currentTime: 0 });
    vi.mocked(refreshProjectState).mockResolvedValue({
      assets: new Map(),
      sequences: new Map(),
      effects: new Map(),
      activeSequenceId: null,
    });
  });

  describe('Word Loading', () => {
    it('should return empty words when no clip is selected', () => {
      const { result } = renderHook(() => useTranscriptEditing());
      expect(result.current.words).toEqual([]);
      expect(result.current.assetId).toBeNull();
    });

    it('should load transcript words when a clip is selected', async () => {
      const mockWords = createMockWords(5);
      mockInvoke.mockResolvedValueOnce(mockWords);
      setupClipSelection();

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.words).toHaveLength(5);
      });
      expect(result.current.assetId).toBe('asset_1');
      expect(mockInvoke).toHaveBeenCalledWith('get_transcript_words', {
        assetId: 'asset_1',
      });
    });

    it('should show error when transcript not found', async () => {
      mockInvoke.mockRejectedValueOnce('No transcript found');
      setupClipSelection();

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.error).toBe('No transcript found');
      });
      expect(result.current.words).toEqual([]);
    });

    it('should reload when the selected clip metadata changes in the project store', async () => {
      mockInvoke.mockResolvedValueOnce(createMockWords(2));
      setupClipSelection('asset_1');

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.assetId).toBe('asset_1');
      });

      mockInvoke.mockResolvedValueOnce(createMockWords(3));

      act(() => {
        useProjectStore.setState({
          activeSequenceId: 'seq_2',
          sequences: new Map([
            [
              'seq_2',
              {
                id: 'seq_2',
                name: 'Updated Sequence',
                tracks: [
                  {
                    id: 'track_2',
                    kind: 'video',
                    clips: [
                      {
                        id: 'clip_1',
                        assetId: 'asset_2',
                        range: { sourceInSec: 1.0, sourceOutSec: 11.0 },
                        place: { timelineInSec: 5.0, durationSec: 10.0 },
                        speed: 1.0,
                        effects: [],
                        audio: {},
                        transform: {},
                        opacity: 1.0,
                        blendMode: 'Normal',
                      },
                    ],
                    name: 'Video 2',
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
      });

      await waitFor(() => {
        expect(result.current.assetId).toBe('asset_2');
      });
      expect(mockInvoke).toHaveBeenLastCalledWith('get_transcript_words', {
        assetId: 'asset_2',
      });
    });

    it('should scope transcript words to the selected clip source range', async () => {
      mockInvoke.mockResolvedValueOnce(createMockWords(6));
      setupClipSelection();

      act(() => {
        useProjectStore.setState({
          activeSequenceId: 'seq_1',
          sequences: new Map([
            [
              'seq_1',
              {
                id: 'seq_1',
                name: 'Trimmed Sequence',
                tracks: [
                  {
                    id: 'track_1',
                    kind: 'video',
                    clips: [
                      {
                        id: 'clip_1',
                        assetId: 'asset_1',
                        range: { sourceInSec: 2.0, sourceOutSec: 5.0 },
                        place: { timelineInSec: 10.0, durationSec: 3.0 },
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
      });

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.words.map((word) => word.text)).toEqual(['word2', 'word3', 'word4']);
      });
    });
  });

  describe('Playback Highlighting', () => {
    it('should highlight current word during playback', async () => {
      const mockWords = createMockWords(5);
      mockInvoke.mockResolvedValueOnce(mockWords);
      setupClipSelection();

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.words).toHaveLength(5);
      });

      // Set playhead to 2.5 seconds → should be word at index 2 (2.0-3.0)
      act(() => {
        usePlaybackStore.setState({ currentTime: 2.5 });
      });

      expect(result.current.activeWordIndex).toBe(2);
    });

    it('should return -1 when playhead is outside word range', async () => {
      const mockWords = createMockWords(3); // words cover 0-3 seconds
      mockInvoke.mockResolvedValueOnce(mockWords);
      setupClipSelection();

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.words).toHaveLength(3);
      });

      act(() => {
        usePlaybackStore.setState({ currentTime: 99.0 });
      });

      expect(result.current.activeWordIndex).toBe(-1);
    });
  });

  describe('Click to Seek', () => {
    it('should seek playhead to word start time when clicked', async () => {
      const mockWords = createMockWords(5);
      mockInvoke.mockResolvedValueOnce(mockWords);
      setupClipSelection();

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.words).toHaveLength(5);
      });

      act(() => {
        result.current.seekToWord(3); // Word 3 starts at 3.0s
      });

      expect(usePlaybackStore.getState().currentTime).toBe(3.0);
    });
  });

  describe('Selection', () => {
    it('should manage word selection range', async () => {
      const mockWords = createMockWords(5);
      mockInvoke.mockResolvedValueOnce(mockWords);
      setupClipSelection();

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.words).toHaveLength(5);
      });

      act(() => {
        result.current.setSelection({ startIndex: 1, endIndex: 3 });
      });

      expect(result.current.selection).toEqual({
        startIndex: 1,
        endIndex: 3,
      });
    });
  });

  describe('Delete Selection', () => {
    it('should call delete_transcript_range IPC with correct args', async () => {
      const mockWords = createMockWords(5);
      mockInvoke.mockResolvedValueOnce(mockWords); // load words
      mockInvoke.mockResolvedValueOnce({ success: true }); // delete
      mockInvoke.mockResolvedValueOnce(createMockWords(3)); // reload
      setupClipSelection();

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.words).toHaveLength(5);
      });

      act(() => {
        result.current.setSelection({ startIndex: 1, endIndex: 2 });
      });

      await act(async () => {
        await result.current.deleteSelection();
      });

      expect(mockInvoke).toHaveBeenCalledWith('delete_transcript_range', {
        args: {
          sequenceId: 'seq_1',
          trackId: 'track_1',
          clipId: 'clip_1',
          startSec: 1.0, // word1 starts at 1.0
          endSec: 3.0, // word2 ends at 3.0
        },
      });
      expect(refreshProjectState).toHaveBeenCalledTimes(1);
    });
  });

  describe('Reorder Selection', () => {
    it('should call reorder_transcript_segment IPC with correct args', async () => {
      const mockWords = createMockWords(5);
      mockInvoke.mockResolvedValueOnce(mockWords); // load words
      mockInvoke.mockResolvedValueOnce({ success: true }); // reorder
      mockInvoke.mockResolvedValueOnce(createMockWords(5)); // reload
      setupClipSelection();

      const { result } = renderHook(() => useTranscriptEditing());

      await waitFor(() => {
        expect(result.current.words).toHaveLength(5);
      });

      act(() => {
        result.current.setSelection({ startIndex: 0, endIndex: 1 });
      });

      await act(async () => {
        await result.current.reorderToPosition(4);
      });

      expect(mockInvoke).toHaveBeenCalledWith('reorder_transcript_segment', {
        args: {
          sequenceId: 'seq_1',
          trackId: 'track_1',
          clipId: 'clip_1',
          sourceStartSec: 0.0,
          sourceEndSec: 2.0,
          targetPositionSec: 4.0, // word4 starts at 4.0s
        },
      });
      expect(refreshProjectState).toHaveBeenCalledTimes(1);
    });
  });
});

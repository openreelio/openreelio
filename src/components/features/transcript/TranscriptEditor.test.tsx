/**
 * TranscriptEditor Component Tests
 *
 * BDD-style integration tests for the transcript editing panel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { TranscriptEditor } from './TranscriptEditor';
import { useProjectStore } from '@/stores/projectStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { TranscriptWord } from '@/hooks/useTranscriptEditing';

const mockInvoke = vi.mocked(invoke);

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

function setupClipSelection(): void {
  useTimelineStore.setState({ selectedClipIds: ['clip_1'] });
  useProjectStore.setState({
    activeSequenceId: 'seq_1',
    sequences: new Map([
      [
        'seq_1',
        {
          id: 'seq_1',
          name: 'Test',
          tracks: [
            {
              id: 'track_1',
              kind: 'video',
              clips: [
                {
                  id: 'clip_1',
                  assetId: 'asset_1',
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

describe('TranscriptEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTimelineStore.setState({ selectedClipIds: [] });
    useProjectStore.setState({ activeSequenceId: null, sequences: new Map() });
    usePlaybackStore.setState({ currentTime: 0 });
  });

  it('should show empty state when no clip is selected', () => {
    render(<TranscriptEditor />);
    expect(screen.getByText('Select a clip to view its transcript')).toBeInTheDocument();
  });

  it('should show loading state while fetching words', () => {
    mockInvoke.mockReturnValue(new Promise(() => {})); // Never resolves
    setupClipSelection();
    render(<TranscriptEditor />);
    expect(screen.getByText('Loading transcript...')).toBeInTheDocument();
  });

  it('should display transcript words when loaded', async () => {
    mockInvoke.mockResolvedValueOnce(createMockWords(4));
    setupClipSelection();
    render(<TranscriptEditor />);

    await waitFor(() => {
      expect(screen.getByText('word0')).toBeInTheDocument();
      expect(screen.getByText('word1')).toBeInTheDocument();
      expect(screen.getByText('word2')).toBeInTheDocument();
      expect(screen.getByText('word3')).toBeInTheDocument();
    });
  });

  it('should show error state when transcript loading fails', async () => {
    mockInvoke.mockRejectedValueOnce('No transcript found for asset');
    setupClipSelection();
    render(<TranscriptEditor />);

    await waitFor(() => {
      expect(screen.getByText('No transcript found for asset')).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('should show no-transcript state for empty word list', async () => {
    mockInvoke.mockResolvedValueOnce([]);
    setupClipSelection();
    render(<TranscriptEditor />);

    await waitFor(() => {
      expect(
        screen.getByText('No transcript available. Run transcription first.')
      ).toBeInTheDocument();
    });
  });

  it('should seek playhead when clicking a word', async () => {
    mockInvoke.mockResolvedValueOnce(createMockWords(3));
    setupClipSelection();
    render(<TranscriptEditor />);

    await waitFor(() => {
      expect(screen.getByText('word2')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('word2'));
    expect(usePlaybackStore.getState().currentTime).toBe(2.0);
  });

  it('should mark active word with font-medium during playback', async () => {
    mockInvoke.mockResolvedValueOnce(createMockWords(3));
    setupClipSelection();
    const { rerender } = render(<TranscriptEditor />);

    await waitFor(() => {
      expect(screen.getByText('word1')).toBeInTheDocument();
    });

    // Move playhead to word1's range (1.0-2.0s)
    act(() => {
      usePlaybackStore.setState({ currentTime: 1.5 });
      rerender(<TranscriptEditor />);
    });

    // The active word should have the bold/medium styling applied
    const activeWord = screen.getByText('word1');
    const inactiveWord = screen.getByText('word0');
    expect(activeWord.className).not.toEqual(inactiveWord.className);
  });

  it('should show selection toolbar when words are selected', async () => {
    mockInvoke.mockResolvedValueOnce(createMockWords(5));
    setupClipSelection();
    render(<TranscriptEditor />);

    await waitFor(() => {
      expect(screen.getByText('word0')).toBeInTheDocument();
    });

    // Simulate selection by mouse drag: mousedown on word0, mousemove to word2
    fireEvent.mouseDown(screen.getByText('word0'));
    fireEvent.mouseEnter(screen.getByText('word2'));
    fireEvent.mouseUp(screen.getByText('word2'));

    expect(screen.getByText(/3 words selected/)).toBeInTheDocument();
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('should clear selection on Escape key', async () => {
    mockInvoke.mockResolvedValueOnce(createMockWords(5));
    setupClipSelection();
    render(<TranscriptEditor />);

    await waitFor(() => {
      expect(screen.getByText('word0')).toBeInTheDocument();
    });

    // Select words
    fireEvent.mouseDown(screen.getByText('word0'));
    fireEvent.mouseEnter(screen.getByText('word1'));
    fireEvent.mouseUp(screen.getByText('word1'));

    expect(screen.getByText(/2 words selected/)).toBeInTheDocument();

    // Press Escape on the container
    const container = screen.getByRole('textbox');
    fireEvent.keyDown(container, { key: 'Escape' });

    expect(screen.queryByText(/words selected/)).not.toBeInTheDocument();
  });

  it('should have proper accessibility attributes', async () => {
    mockInvoke.mockResolvedValueOnce(createMockWords(2));
    setupClipSelection();
    render(<TranscriptEditor />);

    await waitFor(() => {
      expect(screen.getByText('word0')).toBeInTheDocument();
    });

    const container = screen.getByRole('textbox');
    expect(container).toHaveAttribute('aria-label', 'Transcript editor');

    const wordList = screen.getByRole('list');
    expect(wordList).toHaveAttribute('aria-label', 'Transcript words');
  });
});

/**
 * TimelinePreviewPlayer Component Tests
 *
 * TDD tests for canvas-based timeline preview player
 * that renders composite frames from multiple clips.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TimelinePreviewPlayer } from './TimelinePreviewPlayer';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import type { Clip, Track, Asset, Sequence } from '@/types';

// Mock the hooks
vi.mock('@/hooks/usePlaybackLoop', () => ({
  usePlaybackLoop: vi.fn(() => ({
    isActive: false,
    frameCount: 0,
    actualFps: 30,
    droppedFrames: 0,
  })),
}));

vi.mock('@/hooks/useFrameExtractor', () => ({
  useAssetFrameExtractor: vi.fn(() => ({
    extractFrame: vi.fn().mockResolvedValue('asset://localhost/frame.jpg'),
    prefetchFrames: vi.fn(),
    isLoading: false,
    error: null,
    cacheStats: { entryCount: 0, totalSizeBytes: 0, hits: 0, misses: 0, hitRate: 0 },
  })),
}));

import { usePlaybackLoop } from '@/hooks/usePlaybackLoop';
import { useAssetFrameExtractor } from '@/hooks/useFrameExtractor';

const mockUsePlaybackLoop = vi.mocked(usePlaybackLoop);
const mockUseAssetFrameExtractor = vi.mocked(useAssetFrameExtractor);

describe('TimelinePreviewPlayer', () => {
  // Sample test data
  const mockAsset: Asset = {
    id: 'asset-1',
    kind: 'video',
    name: 'test-video.mp4',
    uri: '/path/to/video.mp4',
    hash: 'hash',
    durationSec: 10,
    fileSize: 1024000,
    importedAt: new Date().toISOString(),
    license: {
      source: 'user',
      licenseType: 'unknown',
      allowedUse: [],
    },
    tags: [],
    proxyStatus: 'notNeeded',
  };

  const mockClip: Clip = {
    id: 'clip-1',
    assetId: 'asset-1',
    range: { sourceInSec: 0, sourceOutSec: 5 },
    place: { timelineInSec: 0, durationSec: 5 },
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
  };

  const mockTrack: Track = {
    id: 'track-1',
    kind: 'video',
    name: 'Video 1',
    clips: [mockClip],
    blendMode: 'normal',
    locked: false,
    muted: false,
    visible: true,
    volume: 1,
  };

  const mockSequence: Sequence = {
    id: 'seq-1',
    name: 'Sequence 1',
    format: {
      canvas: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      audioSampleRate: 48000,
      audioChannels: 2,
    },
    tracks: [mockTrack],
    markers: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset playback store
    usePlaybackStore.getState().reset();

    // Setup mock project store with assets
    const assetsMap = new Map<string, Asset>();
    assetsMap.set(mockAsset.id, mockAsset);
    useProjectStore.setState({
      assets: assetsMap,
      selectedAssetId: null,
    });

    // Setup mock project sequences (activeSequenceId is set per-test)
    const sequencesMap = new Map<string, Sequence>();
    sequencesMap.set(mockSequence.id, mockSequence);
    useProjectStore.setState({
      sequences: sequencesMap,
      activeSequenceId: null,
    });

    // Default mock implementations
    mockUsePlaybackLoop.mockReturnValue({
      isActive: false,
      frameCount: 0,
      actualFps: 30,
      droppedFrames: 0,
    });

    mockUseAssetFrameExtractor.mockReturnValue({
      extractFrame: vi.fn().mockResolvedValue('asset://localhost/frame.jpg'),
      prefetchFrames: vi.fn(),
      isLoading: false,
      error: null,
      cacheStats: { entryCount: 0, totalSizeBytes: 0, hits: 0, misses: 0, hitRate: 0 },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering
  // ===========================================================================

  describe('Rendering', () => {
    it('should render empty state when no sequence is active', () => {
      render(<TimelinePreviewPlayer />);

      expect(screen.getByTestId('timeline-preview-player')).toBeInTheDocument();
      expect(screen.getByText(/no sequence/i)).toBeInTheDocument();
    });

    it('should render canvas element when sequence is active', () => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });

      render(<TimelinePreviewPlayer />);

      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should render playback controls', () => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });

      render(<TimelinePreviewPlayer showControls />);

      expect(screen.getByRole('button', { name: /play/i })).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      const { container } = render(
        <TimelinePreviewPlayer className="custom-class" />
      );

      expect(container.firstChild).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Playback Controls
  // ===========================================================================

  describe('Playback Controls', () => {
    beforeEach(() => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });
    });

    it('should toggle play/pause on button click', () => {
      render(<TimelinePreviewPlayer showControls />);

      const playButton = screen.getByRole('button', { name: /play/i });
      fireEvent.click(playButton);

      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it('should show pause button when playing', () => {
      usePlaybackStore.getState().play();

      render(<TimelinePreviewPlayer showControls />);

      expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument();
    });

    it('should toggle play/pause with space key', () => {
      render(<TimelinePreviewPlayer showControls />);

      const player = screen.getByTestId('timeline-preview-player');
      fireEvent.keyDown(player, { key: ' ' });

      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });
  });

  // ===========================================================================
  // Frame Display
  // ===========================================================================

  describe('Frame Display', () => {
    beforeEach(() => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });
    });

    it('should render canvas for frame display', () => {
      render(<TimelinePreviewPlayer />);

      // Canvas should be rendered for frame display
      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should display loading state during extraction', () => {
      mockUseAssetFrameExtractor.mockReturnValue({
        extractFrame: vi.fn(),
        prefetchFrames: vi.fn(),
        isLoading: true,
        error: null,
        cacheStats: { entryCount: 0, totalSizeBytes: 0, hits: 0, misses: 0, hitRate: 0 },
      });

      render(<TimelinePreviewPlayer />);

      expect(screen.getByTestId('preview-loading')).toBeInTheDocument();
    });

    it('should display error state when extraction fails', () => {
      mockUseAssetFrameExtractor.mockReturnValue({
        extractFrame: vi.fn(),
        prefetchFrames: vi.fn(),
        isLoading: false,
        error: new Error('Extraction failed'),
        cacheStats: { entryCount: 0, totalSizeBytes: 0, hits: 0, misses: 0, hitRate: 0 },
      });

      render(<TimelinePreviewPlayer />);

      expect(screen.getByTestId('preview-error')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Time Display
  // ===========================================================================

  describe('Time Display', () => {
    beforeEach(() => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });
      usePlaybackStore.setState({ duration: 60 });
    });

    it('should display current time', () => {
      act(() => {
        usePlaybackStore.getState().setCurrentTime(5.5);
      });

      render(<TimelinePreviewPlayer showTimecode />);

      expect(screen.getByText(/0:05/)).toBeInTheDocument();
    });

    it('should display duration in controls', () => {
      // Duration is shown in controls, not in timecode overlay
      render(<TimelinePreviewPlayer showControls showTimecode />);

      // Should show current time / duration format
      expect(screen.getByText(/0:00.*1:00/)).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Playback Loop Integration
  // ===========================================================================

  describe('Playback Loop Integration', () => {
    beforeEach(() => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });
    });

    it('should pass correct options to usePlaybackLoop', () => {
      usePlaybackStore.setState({ duration: 30 });

      render(<TimelinePreviewPlayer />);

      expect(mockUsePlaybackLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          duration: 30,
          onFrame: expect.any(Function),
          onEnded: expect.any(Function),
        })
      );
    });

    it('should call onEnded callback when playback ends', () => {
      const onEnded = vi.fn();

      render(<TimelinePreviewPlayer onEnded={onEnded} />);

      // Get the onEnded callback passed to usePlaybackLoop
      const options = mockUsePlaybackLoop.mock.calls[0][0];
      options.onEnded?.();

      expect(onEnded).toHaveBeenCalled();
    });

    it('should display FPS counter when showStats is true', () => {
      mockUsePlaybackLoop.mockReturnValue({
        isActive: true,
        frameCount: 100,
        actualFps: 29.5,
        droppedFrames: 2,
      });

      render(<TimelinePreviewPlayer showStats />);

      expect(screen.getByText(/29\.5 fps/i)).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Clip Resolution
  // ===========================================================================

  describe('Clip Resolution', () => {
    beforeEach(() => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });
    });

    it('should render without error when clip exists at current time', () => {
      // Set time within clip range (clip starts at 0, duration 5)
      act(() => {
        usePlaybackStore.getState().setCurrentTime(2.0);
      });

      render(<TimelinePreviewPlayer />);

      // Should render canvas without error
      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
      expect(screen.queryByTestId('preview-error')).not.toBeInTheDocument();
    });

    it('should render without error when no clip at current time', () => {
      // Set time outside clip range (clip is 0-5, set to 7)
      act(() => {
        usePlaybackStore.getState().setCurrentTime(7.0);
      });

      render(<TimelinePreviewPlayer />);

      // Should render canvas without error (shows black)
      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
      expect(screen.queryByTestId('preview-error')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Seeking
  // ===========================================================================

  describe('Seeking', () => {
    beforeEach(() => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });
      usePlaybackStore.setState({ duration: 60 });
    });

    it('should seek when seek bar is clicked', () => {
      render(<TimelinePreviewPlayer showControls />);

      const seekBar = screen.getByTestId('preview-seek-bar');

      // Mock getBoundingClientRect
      const mockRect = { left: 0, width: 100 } as DOMRect;
      vi.spyOn(seekBar, 'getBoundingClientRect').mockReturnValue(mockRect);

      // Click at 50% of the seek bar
      fireEvent.click(seekBar, { clientX: 50 });

      // Should seek to 50% of duration (30 seconds)
      expect(usePlaybackStore.getState().currentTime).toBe(30);
    });

    it('should support drag seeking', () => {
      render(<TimelinePreviewPlayer showControls />);

      const seekBar = screen.getByTestId('preview-seek-bar');
      const mockRect = { left: 0, width: 100 } as DOMRect;
      vi.spyOn(seekBar, 'getBoundingClientRect').mockReturnValue(mockRect);

      fireEvent.mouseDown(seekBar, { clientX: 25 });
      fireEvent.mouseMove(window, { clientX: 75 });
      fireEvent.mouseUp(window);

      // Should end up at 75% of duration
      expect(usePlaybackStore.getState().currentTime).toBe(45);
    });
  });

  // ===========================================================================
  // Responsive Sizing
  // ===========================================================================

  describe('Responsive Sizing', () => {
    beforeEach(() => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });
    });

    it('should maintain aspect ratio', () => {
      render(<TimelinePreviewPlayer aspectRatio={16 / 9} />);

      const player = screen.getByTestId('timeline-preview-player');
      expect(player).toHaveStyle({ aspectRatio: '1.7777777777777777' });
    });

    it('should accept custom width and height', () => {
      render(<TimelinePreviewPlayer width={640} height={360} />);

      const canvas = screen.getByTestId('preview-canvas');
      expect(canvas).toHaveAttribute('width', '640');
      expect(canvas).toHaveAttribute('height', '360');
    });
  });

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  describe('Cleanup', () => {
    it('should stop playback on unmount', () => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });
      usePlaybackStore.getState().play();

      const { unmount } = render(<TimelinePreviewPlayer />);

      unmount();

      expect(usePlaybackStore.getState().isPlaying).toBe(false);
    });
  });
});

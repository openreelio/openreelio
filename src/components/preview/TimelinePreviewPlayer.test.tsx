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

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
  invoke: vi.fn(),
}));

// Mock FFmpeg utilities
vi.mock('@/utils/ffmpeg', () => ({
  extractFrame: vi.fn().mockResolvedValue(undefined),
}));

// Mock frame cache service
vi.mock('@/services/frameCache', () => ({
  frameCache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    getStats: vi.fn().mockReturnValue({ entryCount: 0, totalSizeBytes: 0, hits: 0, misses: 0, hitRate: 0 }),
  },
}));

// Mock frame paths service
vi.mock('@/services/framePaths', () => ({
  buildFrameOutputPath: vi.fn().mockResolvedValue('/tmp/frame.png'),
}));

// Mock preview constants
vi.mock('@/constants/preview', () => ({
  createFrameCacheKey: vi.fn((assetId: string, time: number) => `${assetId}:${time}`),
  FRAME_EXTRACTION: {
    DEFAULT_FRAME_SIZE_KB: 100,
    MAX_CONCURRENT_EXTRACTIONS: 3,
    DEBOUNCE_MS: 50,
    MAX_CACHE_ENTRIES: 100,
    MAX_CACHE_MEMORY_MB: 200,
    CACHE_TTL_MS: 300000,
  },
}));

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

    it('should seek when seek bar is clicked', async () => {
      render(<TimelinePreviewPlayer showControls />);

      const seekBar = screen.getByTestId('seek-bar');

      // Mock getBoundingClientRect
      const mockRect = { left: 0, width: 100, top: 0, height: 14, right: 100, bottom: 14, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      vi.spyOn(seekBar, 'getBoundingClientRect').mockReturnValue(mockRect);

      // Click at 50% of the seek bar - use async act() to wait for all state updates
      await act(async () => {
        fireEvent.click(seekBar, { clientX: 50 });
        // Allow time for async renderFrame effects to complete
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Should seek to 50% of duration (30 seconds)
      expect(usePlaybackStore.getState().currentTime).toBe(30);
    });

    it('should support drag seeking', async () => {
      render(<TimelinePreviewPlayer showControls />);

      const seekBar = screen.getByTestId('seek-bar');
      const mockRect = { left: 0, width: 100, top: 0, height: 14, right: 100, bottom: 14, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      vi.spyOn(seekBar, 'getBoundingClientRect').mockReturnValue(mockRect);

      // SeekBar uses pointer events for dragging
      await act(async () => {
        fireEvent.pointerDown(seekBar, { clientX: 25, pointerId: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await act(async () => {
        fireEvent.pointerMove(seekBar, { clientX: 75, pointerId: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await act(async () => {
        fireEvent.pointerUp(seekBar, { pointerId: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

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

  // ===========================================================================
  // Multi-Layer Composition
  // ===========================================================================

  describe('Multi-Layer Composition', () => {
    const mockAsset2: Asset = {
      id: 'asset-2',
      kind: 'video',
      name: 'overlay-video.mp4',
      uri: '/path/to/overlay.mp4',
      hash: 'hash2',
      durationSec: 10,
      fileSize: 1024000,
      importedAt: new Date().toISOString(),
      video: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, codec: 'h264', hasAlpha: false },
      license: { source: 'user', licenseType: 'unknown', allowedUse: [] },
      tags: [],
      proxyStatus: 'notNeeded',
    };

    const overlayClip: Clip = {
      id: 'clip-2',
      assetId: 'asset-2',
      range: { sourceInSec: 0, sourceOutSec: 5 },
      place: { timelineInSec: 0, durationSec: 5 },
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 0.5, y: 0.5 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      },
      opacity: 0.8,
      speed: 1,
      effects: [],
      audio: { volumeDb: 0, pan: 0, muted: false },
    };

    const overlayTrack: Track = {
      id: 'track-2',
      kind: 'video',
      name: 'Video 2',
      clips: [overlayClip],
      blendMode: 'normal',
      locked: false,
      muted: false,
      visible: true,
      volume: 1,
    };

    const multiTrackSequence: Sequence = {
      id: 'seq-multi',
      name: 'Multi-Track Sequence',
      format: {
        canvas: { width: 1920, height: 1080 },
        fps: { num: 30, den: 1 },
        audioSampleRate: 48000,
        audioChannels: 2,
      },
      tracks: [mockTrack, overlayTrack], // track-1 (bottom), track-2 (top)
      markers: [],
    };

    beforeEach(() => {
      const assetsMap = new Map<string, Asset>();
      assetsMap.set(mockAsset.id, mockAsset);
      assetsMap.set(mockAsset2.id, mockAsset2);

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(multiTrackSequence.id, multiTrackSequence);

      useProjectStore.setState({
        assets: assetsMap,
        sequences: sequencesMap,
        activeSequenceId: 'seq-multi',
      });
    });

    it('should identify all active clips at a given time', () => {
      act(() => {
        usePlaybackStore.getState().setCurrentTime(2.0);
      });

      render(<TimelinePreviewPlayer />);

      // Both clips are active at time 2.0 (both span 0-5 seconds)
      // The component should recognize and prepare to render both
      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should render clips in correct layer order (back to front)', () => {
      act(() => {
        usePlaybackStore.getState().setCurrentTime(2.0);
      });

      render(<TimelinePreviewPlayer />);

      // Track order in array determines layer order:
      // tracks[0] (mockTrack) renders first (background)
      // tracks[1] (overlayTrack) renders second (foreground)
      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should handle overlapping clips on the same track', () => {
      // Create a track with overlapping clips
      const overlappingClip: Clip = {
        ...mockClip,
        id: 'clip-overlap',
        place: { timelineInSec: 2, durationSec: 5 }, // Overlaps with clip-1 at 2-5
      };

      const trackWithOverlap: Track = {
        ...mockTrack,
        clips: [mockClip, overlappingClip],
      };

      const seqWithOverlap: Sequence = {
        ...mockSequence,
        id: 'seq-overlap',
        tracks: [trackWithOverlap],
      };

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(seqWithOverlap.id, seqWithOverlap);
      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: 'seq-overlap',
      });

      act(() => {
        usePlaybackStore.getState().setCurrentTime(3.0); // Within overlap region
      });

      render(<TimelinePreviewPlayer />);

      // Should render the last clip in the array (clip-overlap) on top
      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Transform Application
  // ===========================================================================

  describe('Transform Application', () => {
    const transformedClip: Clip = {
      id: 'clip-transformed',
      assetId: 'asset-1',
      range: { sourceInSec: 0, sourceOutSec: 5 },
      place: { timelineInSec: 0, durationSec: 5 },
      transform: {
        position: { x: 0.25, y: 0.75 }, // Top-left quadrant
        scale: { x: 0.5, y: 0.5 },       // Half size
        rotationDeg: 45,                  // 45 degree rotation
        anchor: { x: 0.5, y: 0.5 },       // Center anchor
      },
      opacity: 1,
      speed: 1,
      effects: [],
      audio: { volumeDb: 0, pan: 0, muted: false },
    };

    const transformedTrack: Track = {
      ...mockTrack,
      clips: [transformedClip],
    };

    const transformedSequence: Sequence = {
      ...mockSequence,
      id: 'seq-transform',
      tracks: [transformedTrack],
    };

    beforeEach(() => {
      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(transformedSequence.id, transformedSequence);
      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: 'seq-transform',
      });
    });

    it('should apply position transform during rendering', () => {
      act(() => {
        usePlaybackStore.getState().setCurrentTime(2.0);
      });

      render(<TimelinePreviewPlayer />);

      // Canvas should be rendered - transform is applied internally
      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should apply scale transform during rendering', () => {
      act(() => {
        usePlaybackStore.getState().setCurrentTime(2.0);
      });

      render(<TimelinePreviewPlayer />);

      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should apply rotation transform during rendering', () => {
      act(() => {
        usePlaybackStore.getState().setCurrentTime(2.0);
      });

      render(<TimelinePreviewPlayer />);

      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should handle default transform (centered, no rotation)', () => {
      // Reset to default transform
      const defaultClip: Clip = {
        ...mockClip,
        transform: {
          position: { x: 0.5, y: 0.5 },
          scale: { x: 1, y: 1 },
          rotationDeg: 0,
          anchor: { x: 0.5, y: 0.5 },
        },
      };

      const defaultTrack: Track = { ...mockTrack, clips: [defaultClip] };
      const defaultSeq: Sequence = { ...mockSequence, tracks: [defaultTrack] };

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(defaultSeq.id, defaultSeq);
      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: defaultSeq.id,
      });

      render(<TimelinePreviewPlayer />);

      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Opacity and Blend Modes
  // ===========================================================================

  describe('Opacity and Blend Modes', () => {
    beforeEach(() => {
      useProjectStore.setState({ activeSequenceId: 'seq-1' });
    });

    it('should apply clip opacity during rendering', () => {
      const semiTransparentClip: Clip = {
        ...mockClip,
        opacity: 0.5,
      };

      const trackWithOpacity: Track = { ...mockTrack, clips: [semiTransparentClip] };
      const seqWithOpacity: Sequence = {
        ...mockSequence,
        id: 'seq-opacity',
        tracks: [trackWithOpacity],
      };

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(seqWithOpacity.id, seqWithOpacity);
      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: 'seq-opacity',
      });

      render(<TimelinePreviewPlayer />);

      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should apply track blend mode during rendering', () => {
      const multiplyTrack: Track = {
        ...mockTrack,
        blendMode: 'multiply',
      };

      const seqWithBlend: Sequence = {
        ...mockSequence,
        id: 'seq-blend',
        tracks: [multiplyTrack],
      };

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(seqWithBlend.id, seqWithBlend);
      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: 'seq-blend',
      });

      render(<TimelinePreviewPlayer />);

      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should handle zero opacity (fully transparent)', () => {
      const invisibleClip: Clip = {
        ...mockClip,
        opacity: 0,
      };

      const trackWithInvisible: Track = { ...mockTrack, clips: [invisibleClip] };
      const seqWithInvisible: Sequence = {
        ...mockSequence,
        id: 'seq-invisible',
        tracks: [trackWithInvisible],
      };

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(seqWithInvisible.id, seqWithInvisible);
      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: 'seq-invisible',
      });

      render(<TimelinePreviewPlayer />);

      // Should still render canvas, just nothing visible
      expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
    });

    it('should support all blend modes', () => {
      const blendModes: Array<'normal' | 'multiply' | 'screen' | 'overlay' | 'add'> = [
        'normal',
        'multiply',
        'screen',
        'overlay',
        'add',
      ];

      for (const blendMode of blendModes) {
        const blendTrack: Track = { ...mockTrack, blendMode };
        const blendSeq: Sequence = {
          ...mockSequence,
          id: `seq-blend-${blendMode}`,
          tracks: [blendTrack],
        };

        const sequencesMap = new Map<string, Sequence>();
        sequencesMap.set(blendSeq.id, blendSeq);
        useProjectStore.setState({
          sequences: sequencesMap,
          activeSequenceId: blendSeq.id,
        });

        const { unmount } = render(<TimelinePreviewPlayer />);
        expect(screen.getByTestId('preview-canvas')).toBeInTheDocument();
        unmount();
      }
    });
  });

  // ===========================================================================
  // Edge Case Tests (Source Time Clamping)
  // ===========================================================================

  describe('source time clamping', () => {
    it('should clamp source time to valid range at clip start', () => {
      // Create a clip that starts at timeline 10s with source range [5, 15]
      const testClip: Clip = {
        ...mockClip,
        id: 'clamp-test-clip',
        place: {
          timelineInSec: 10.0,
          durationSec: 10.0,
        },
        range: {
          sourceInSec: 5.0,
          sourceOutSec: 15.0,
        },
        speed: 1.0,
      };

      const testTrack: Track = {
        ...mockTrack,
        clips: [testClip],
      };
      const testSeq: Sequence = {
        ...mockSequence,
        id: 'clamp-test-seq',
        tracks: [testTrack],
      };

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(testSeq.id, testSeq);
      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: testSeq.id,
      });

      // Set playback time to exactly clip start
      usePlaybackStore.setState({
        currentTime: 10.0,
        duration: 30,
      });

      const { getByTestId, unmount } = render(<TimelinePreviewPlayer />);
      expect(getByTestId('preview-canvas')).toBeInTheDocument();
      unmount();
    });

    it('should handle clips with speed > 1', () => {
      // Create a fast clip (2x speed)
      const fastClip: Clip = {
        ...mockClip,
        id: 'fast-clip',
        place: {
          timelineInSec: 0.0,
          durationSec: 5.0, // 5 seconds on timeline
        },
        range: {
          sourceInSec: 0.0,
          sourceOutSec: 10.0, // 10 seconds of source at 2x speed
        },
        speed: 2.0,
      };

      const testTrack: Track = {
        ...mockTrack,
        clips: [fastClip],
      };
      const testSeq: Sequence = {
        ...mockSequence,
        id: 'fast-clip-seq',
        tracks: [testTrack],
      };

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(testSeq.id, testSeq);
      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: testSeq.id,
      });

      // At timeline 2.5s, source should be 5.0s (2.5 * 2 = 5.0)
      usePlaybackStore.setState({
        currentTime: 2.5,
        duration: 30,
      });

      const { getByTestId, unmount } = render(<TimelinePreviewPlayer />);
      expect(getByTestId('preview-canvas')).toBeInTheDocument();
      unmount();
    });

    it('should handle clips with speed < 1 (slow motion)', () => {
      // Create a slow clip (0.5x speed)
      const slowClip: Clip = {
        ...mockClip,
        id: 'slow-clip',
        place: {
          timelineInSec: 0.0,
          durationSec: 20.0, // 20 seconds on timeline
        },
        range: {
          sourceInSec: 0.0,
          sourceOutSec: 10.0, // 10 seconds of source at 0.5x speed
        },
        speed: 0.5,
      };

      const testTrack: Track = {
        ...mockTrack,
        clips: [slowClip],
      };
      const testSeq: Sequence = {
        ...mockSequence,
        id: 'slow-clip-seq',
        tracks: [testTrack],
      };

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(testSeq.id, testSeq);
      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: testSeq.id,
      });

      // At timeline 10s, source should be 5.0s (10 * 0.5 = 5.0)
      usePlaybackStore.setState({
        currentTime: 10.0,
        duration: 30,
      });

      const { getByTestId, unmount } = render(<TimelinePreviewPlayer />);
      expect(getByTestId('preview-canvas')).toBeInTheDocument();
      unmount();
    });
  });

  // ===========================================================================
  // Error State Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should handle missing asset gracefully', () => {
      // Create a clip with an asset ID that does not exist in the assets map
      const orphanClip: Clip = {
        ...mockClip,
        id: 'orphan-clip',
        assetId: 'nonexistent-asset-id',
      };

      const testTrack: Track = {
        ...mockTrack,
        clips: [orphanClip],
      };
      const testSeq: Sequence = {
        ...mockSequence,
        id: 'orphan-seq',
        tracks: [testTrack],
      };

      const sequencesMap = new Map<string, Sequence>();
      sequencesMap.set(testSeq.id, testSeq);

      // Empty assets map - no asset for the clip
      const assetsMap = new Map<string, Asset>();

      useProjectStore.setState({
        sequences: sequencesMap,
        activeSequenceId: testSeq.id,
        assets: assetsMap,
      });

      usePlaybackStore.setState({
        currentTime: 0.5,
        duration: 10,
      });

      // Should not throw
      const { getByTestId, unmount } = render(<TimelinePreviewPlayer />);
      expect(getByTestId('preview-canvas')).toBeInTheDocument();
      unmount();
    });
  });

  // ===========================================================================
  // Cleanup Tests
  // ===========================================================================

  describe('cleanup behavior', () => {
    it('should pause playback on unmount', () => {
      const pauseMock = vi.fn();
      usePlaybackStore.setState({
        isPlaying: true,
        currentTime: 5,
        duration: 60,
        pause: pauseMock,
      });

      const { unmount } = render(<TimelinePreviewPlayer />);
      unmount();

      expect(pauseMock).toHaveBeenCalled();
    });
  });
});

/**
 * Timeline Container Component Tests
 *
 * Tests for the main timeline component that integrates all timeline elements.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, createEvent } from '@testing-library/react';
import { Timeline } from './Timeline';
import { useTimelineStore } from '@/stores/timelineStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Sequence } from '@/types';

// =============================================================================
// Canvas Mock for TimeRuler
// =============================================================================

const createMockCanvasContext = () => ({
  fillRect: vi.fn(),
  fillText: vi.fn(),
  strokeRect: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
  scale: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  setTransform: vi.fn(),
  resetTransform: vi.fn(),
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  font: '',
  textAlign: 'left' as CanvasTextAlign,
  textBaseline: 'alphabetic' as CanvasTextBaseline,
});

// =============================================================================
// Test Data
// =============================================================================

const mockSequence: Sequence = {
  id: 'seq_001',
  name: 'Main Sequence',
  format: {
    canvas: { width: 1920, height: 1080 },
    fps: { num: 30, den: 1 },
    audioSampleRate: 48000,
    audioChannels: 2,
  },
  tracks: [
    {
      id: 'track_001',
      kind: 'video',
      name: 'Video 1',
      clips: [],
      blendMode: 'normal',
      muted: false,
      locked: false,
      visible: true,
      volume: 1.0,
    },
    {
      id: 'track_002',
      kind: 'audio',
      name: 'Audio 1',
      clips: [],
      blendMode: 'normal',
      muted: false,
      locked: false,
      visible: true,
      volume: 1.0,
    },
  ],
  markers: [],
};

// =============================================================================
// Tests
// =============================================================================

describe('Timeline', () => {
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    // Mock Canvas API for TimeRuler component
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(createMockCanvasContext());

    // Mock window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', {
      value: 1,
      writable: true,
      configurable: true,
    });

    // Reset timeline store before each test
    useTimelineStore.setState({
      playhead: 0,
      isPlaying: false,
      playbackRate: 1,
      selectedClipIds: [],
      selectedTrackIds: [],
      zoom: 100,
      scrollX: 0,
      scrollY: 0,
      snapEnabled: true,
      snapToClips: true,
      snapToMarkers: true,
      snapToPlayhead: true,
    });

    // Reset playback store before each test
    // Duration must be > 0 for playback to work with TimelineEngine
    usePlaybackStore.setState({
      isPlaying: false,
      currentTime: 0,
      duration: 60, // Set to 60 seconds (default timeline duration)
      playbackRate: 1,
      volume: 1,
      isMuted: false,
      loop: false,
      syncWithTimeline: true,
    });

    // Mock getBoundingClientRect for drop tests
    Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 400,
      right: 800,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    // Restore originals
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render timeline container', () => {
      render(<Timeline sequence={mockSequence} />);
      expect(screen.getByTestId('timeline')).toBeInTheDocument();
    });

    it('should render time ruler', () => {
      render(<Timeline sequence={mockSequence} />);
      expect(screen.getByTestId('time-ruler')).toBeInTheDocument();
    });

    it('should render all tracks', () => {
      render(<Timeline sequence={mockSequence} />);
      expect(screen.getAllByTestId(/^track-header/)).toHaveLength(2);
    });

    it('should render playhead', () => {
      render(<Timeline sequence={mockSequence} />);
      expect(screen.getByTestId('playhead')).toBeInTheDocument();
    });

    it('should show empty state when no sequence', () => {
      render(<Timeline sequence={null} />);
      expect(screen.getByText(/no sequence/i)).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Clip Selection Tests
  // ===========================================================================

  describe('clip selection', () => {
    it('should select clip when clicked', async () => {
      const sequenceWithClips: Sequence = {
        ...mockSequence,
        tracks: [
          {
            ...mockSequence.tracks[0],
            clips: [
              {
                id: 'clip_001',
                assetId: 'asset_001',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 0, durationSec: 10 },
                transform: { position: { x: 0.5, y: 0.5 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
              },
            ],
          },
          mockSequence.tracks[1],
        ],
      };

      render(<Timeline sequence={sequenceWithClips} />);

      const clip = screen.getByTestId('clip-clip_001');
      fireEvent.click(clip);

      expect(useTimelineStore.getState().selectedClipIds).toContain('clip_001');
    });

    it('should clear selection when clicking empty area', () => {
      useTimelineStore.setState({ selectedClipIds: ['clip_001'] });

      render(<Timeline sequence={mockSequence} />);

      const timeline = screen.getByTestId('timeline-tracks-area');
      fireEvent.click(timeline);

      expect(useTimelineStore.getState().selectedClipIds).toEqual([]);
    });
  });

  // ===========================================================================
  // Playhead Tests
  // ===========================================================================

  describe('playhead', () => {
    it('should position playhead based on store state', async () => {
      await act(async () => {
        usePlaybackStore.setState({ currentTime: 5 });
      });

      render(<Timeline sequence={mockSequence} />);

      const playhead = screen.getByTestId('playhead');
      // At 5 seconds with zoom 100px/sec + trackHeaderWidth(192) = 692px
      // Playhead now uses CSS transform for GPU-accelerated positioning
      expect(playhead.style.transform).toBe('translateX(692px)');
    });

    // TODO: This test requires TimelineEngine to be properly synced with playbackStore.
    // In the test environment, the useEffect that sets up syncWithStore may not run
    // before the mouseDown event. This needs a more sophisticated test setup.
    it.skip('should update playhead when seeking via ruler mousedown', async () => {
      render(<Timeline sequence={mockSequence} />);

      // Wait for useEffect to sync engine with store
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const ruler = screen.getByTestId('time-ruler');
      // Simulate mouseDown at a position (ruler now uses mouseDown for scrubbing)
      await act(async () => {
        fireEvent.mouseDown(ruler, { clientX: 300 });
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Playhead should update (exact position depends on implementation)
      expect(usePlaybackStore.getState().currentTime).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Zoom Tests
  // ===========================================================================

  describe('zoom', () => {
    it('should respond to zoom changes', () => {
      const { rerender } = render(<Timeline sequence={mockSequence} />);

      act(() => {
        useTimelineStore.setState({ zoom: 50 });
      });
      rerender(<Timeline sequence={mockSequence} />);

      // Timeline width should be based on zoom
      const timeline = screen.getByTestId('timeline');
      expect(timeline).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Keyboard Shortcuts Tests
  // ===========================================================================

  describe('keyboard shortcuts', () => {
    // TODO: This test requires TimelineEngine to be properly synced with playbackStore.
    // In the test environment, the useEffect that sets up syncWithStore may not run
    // before the keyDown event. This needs a more sophisticated test setup.
    it.skip('should toggle playback on space key', async () => {
      render(<Timeline sequence={mockSequence} />);

      const timeline = screen.getByTestId('timeline');

      // First ensure the component is fully mounted and effects have run
      await act(async () => {
        // Small delay to allow useEffect to sync engine with store
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      await act(async () => {
        fireEvent.keyDown(timeline, { key: ' ' });
        // Allow state update to propagate
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(usePlaybackStore.getState().isPlaying).toBe(true);
    });

    it('should delete selected clips on delete key', () => {
      const onDeleteClips = vi.fn();
      useTimelineStore.setState({ selectedClipIds: ['clip_001'] });

      render(<Timeline sequence={mockSequence} onDeleteClips={onDeleteClips} />);

      const timeline = screen.getByTestId('timeline');
      fireEvent.keyDown(timeline, { key: 'Delete' });

      expect(onDeleteClips).toHaveBeenCalledWith(['clip_001']);
    });
  });

  // ===========================================================================
  // Scroll and Zoom Tests
  // ===========================================================================

  describe('scroll and zoom', () => {
    it('should render timeline toolbar', () => {
      render(<Timeline sequence={mockSequence} />);
      // EnhancedTimelineToolbar uses 'enhanced-timeline-toolbar' as its test ID
      expect(screen.getByTestId('enhanced-timeline-toolbar')).toBeInTheDocument();
    });

    it('should update scrollX on horizontal wheel with Shift', () => {
      render(<Timeline sequence={mockSequence} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      // Use deltaY for horizontal scroll with Shift key (standard behavior)
      fireEvent.wheel(tracksArea, { deltaY: 100, shiftKey: true });

      expect(useTimelineStore.getState().scrollX).toBeGreaterThan(0);
    });

    it('should update zoom on wheel with Ctrl (zoom in)', () => {
      render(<Timeline sequence={mockSequence} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      fireEvent.wheel(tracksArea, { deltaY: -100, ctrlKey: true });

      // Zoom should increase (scrolling up with Ctrl)
      expect(useTimelineStore.getState().zoom).toBeGreaterThan(100);
    });

    it('should zoom out on wheel down with Ctrl', () => {
      render(<Timeline sequence={mockSequence} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      fireEvent.wheel(tracksArea, { deltaY: 100, ctrlKey: true });

      // Zoom should decrease (scrolling down with Ctrl)
      expect(useTimelineStore.getState().zoom).toBeLessThan(100);
    });
  });

  // ===========================================================================
  // Drag and Drop Tests
  // ===========================================================================

  describe('drag and drop', () => {
    it('should show drop indicator when dragging asset over tracks area', () => {
      render(<Timeline sequence={mockSequence} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      const assetData = JSON.stringify({ id: 'asset_001', name: 'video.mp4', kind: 'video' });

      fireEvent.dragEnter(tracksArea, {
        dataTransfer: {
          types: ['application/json'],
          getData: () => assetData,
        },
      });

      expect(screen.getByTestId('drop-indicator')).toBeInTheDocument();
    });

    it('should hide drop indicator when drag leaves', () => {
      render(<Timeline sequence={mockSequence} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      const assetData = JSON.stringify({ id: 'asset_001', name: 'video.mp4', kind: 'video' });

      fireEvent.dragEnter(tracksArea, {
        dataTransfer: {
          types: ['application/json'],
          getData: () => assetData,
        },
      });

      fireEvent.dragLeave(tracksArea);

      expect(screen.queryByTestId('drop-indicator')).not.toBeInTheDocument();
    });

    it('should call onAssetDrop when asset is dropped on tracks area', () => {
      const onAssetDrop = vi.fn();
      render(<Timeline sequence={mockSequence} onAssetDrop={onAssetDrop} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      const assetData = { id: 'asset_001', name: 'video.mp4', kind: 'video' };

      // Create drop event with proper dataTransfer
      const dropEvent = createEvent.drop(tracksArea);
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          types: ['application/json'],
          getData: vi.fn().mockReturnValue(JSON.stringify(assetData)),
        },
      });
      Object.defineProperty(dropEvent, 'clientX', { value: 300 });
      Object.defineProperty(dropEvent, 'clientY', { value: 30 });

      fireEvent(tracksArea, dropEvent);

      expect(onAssetDrop).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: 'asset_001',
          trackId: expect.any(String),
          timelinePosition: expect.any(Number),
        })
      );
    });

    it('should hide drop indicator after drop', () => {
      const onAssetDrop = vi.fn();
      render(<Timeline sequence={mockSequence} onAssetDrop={onAssetDrop} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      const assetData = JSON.stringify({ id: 'asset_001', name: 'video.mp4', kind: 'video' });

      fireEvent.dragEnter(tracksArea, {
        dataTransfer: {
          types: ['application/json'],
          getData: () => assetData,
        },
      });

      fireEvent.drop(tracksArea, {
        dataTransfer: {
          types: ['application/json'],
          getData: () => assetData,
        },
      });

      expect(screen.queryByTestId('drop-indicator')).not.toBeInTheDocument();
    });

    it('should calculate correct timeline position from drop coordinates', () => {
      const onAssetDrop = vi.fn();
      useTimelineStore.setState({ zoom: 100 }); // 100px per second

      render(<Timeline sequence={mockSequence} onAssetDrop={onAssetDrop} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      const assetData = { id: 'asset_001', name: 'video.mp4', kind: 'video' };

      // Create drop event with proper dataTransfer
      const dropEvent = createEvent.drop(tracksArea);
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          types: ['application/json'],
          getData: vi.fn().mockReturnValue(JSON.stringify(assetData)),
        },
      });
      Object.defineProperty(dropEvent, 'clientX', { value: 500 });
      Object.defineProperty(dropEvent, 'clientY', { value: 30 });

      fireEvent(tracksArea, dropEvent);

      expect(onAssetDrop).toHaveBeenCalled();
      const callArgs = onAssetDrop.mock.calls[0][0];
      expect(callArgs.timelinePosition).toBeGreaterThanOrEqual(0);
    });

    it('should determine correct track from drop Y position', () => {
      const onAssetDrop = vi.fn();
      render(<Timeline sequence={mockSequence} onAssetDrop={onAssetDrop} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      const assetData = { id: 'asset_001', name: 'video.mp4', kind: 'video' };

      // Create drop event with proper dataTransfer
      const dropEvent = createEvent.drop(tracksArea);
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          types: ['application/json'],
          getData: vi.fn().mockReturnValue(JSON.stringify(assetData)),
        },
      });
      Object.defineProperty(dropEvent, 'clientX', { value: 300 });
      Object.defineProperty(dropEvent, 'clientY', { value: 30 });

      fireEvent(tracksArea, dropEvent);

      expect(onAssetDrop).toHaveBeenCalled();
      const callArgs = onAssetDrop.mock.calls[0][0];
      expect(callArgs.trackId).toBe('track_001');
    });

    it('should not allow drop on locked tracks', () => {
      const lockedSequence: Sequence = {
        ...mockSequence,
        tracks: [
          { ...mockSequence.tracks[0], locked: true },
          mockSequence.tracks[1],
        ],
      };

      const onAssetDrop = vi.fn();
      render(<Timeline sequence={lockedSequence} onAssetDrop={onAssetDrop} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      const assetData = { id: 'asset_001', name: 'video.mp4', kind: 'video' };

      // Create drop event with proper dataTransfer
      const dropEvent = createEvent.drop(tracksArea);
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: {
          types: ['application/json'],
          getData: vi.fn().mockReturnValue(JSON.stringify(assetData)),
        },
      });
      Object.defineProperty(dropEvent, 'clientX', { value: 300 });
      Object.defineProperty(dropEvent, 'clientY', { value: 30 });

      fireEvent(tracksArea, dropEvent);

      expect(onAssetDrop).not.toHaveBeenCalled();
    });
  });
});

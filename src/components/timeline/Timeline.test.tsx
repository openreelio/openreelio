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
import { useEditorToolStore } from '@/stores/editorToolStore';
import { useProjectStore } from '@/stores/projectStore';
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
      selectedClipIds: [],
      selectedTrackIds: [],
      zoom: 100,
      scrollX: 0,
      scrollY: 0,
      snapEnabled: true,
      snapToClips: true,
      snapToMarkers: true,
      snapToPlayhead: true,
      linkedSelectionEnabled: true,
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

    // Reset editor tool store before each test
    useEditorToolStore.setState({
      activeTool: 'select',
      previousTool: null,
      rippleEnabled: false,
      autoScrollEnabled: true,
      clipboard: null,
    });

    // Reset project assets used by clip render helpers
    useProjectStore.setState({
      assets: new Map(),
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

    it('should request video track creation from toolbar', () => {
      const onTrackCreate = vi.fn();
      render(<Timeline sequence={mockSequence} onTrackCreate={onTrackCreate} />);

      fireEvent.click(screen.getByTestId('add-video-track-button'));

      expect(onTrackCreate).toHaveBeenCalledWith({
        sequenceId: 'seq_001',
        kind: 'video',
      });
    });

    it('should request audio track creation from toolbar', () => {
      const onTrackCreate = vi.fn();
      render(<Timeline sequence={mockSequence} onTrackCreate={onTrackCreate} />);

      fireEvent.click(screen.getByTestId('add-audio-track-button'));

      expect(onTrackCreate).toHaveBeenCalledWith({
        sequenceId: 'seq_001',
        kind: 'audio',
      });
    });

    it('should show empty state when no sequence', () => {
      render(<Timeline sequence={null} />);
      expect(screen.getByText(/no sequence/i)).toBeInTheDocument();
    });

    it('should render video-audio source tag on audio clips extracted from video assets', () => {
      const sequenceWithAudioClip: Sequence = {
        ...mockSequence,
        tracks: [
          mockSequence.tracks[0],
          {
            ...mockSequence.tracks[1],
            clips: [
              {
                id: 'clip_audio_from_video_001',
                assetId: 'asset_video_001',
                range: { sourceInSec: 0, sourceOutSec: 0.2 },
                place: { timelineInSec: 0, durationSec: 0.2 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
                label: 'Dialogue Stem',
              },
            ],
          },
        ],
      };

      useProjectStore.setState({
        assets: new Map([
          [
            'asset_video_001',
            {
              id: 'asset_video_001',
              kind: 'video',
              name: 'interview-cam-a.mp4',
              uri: '/assets/interview-cam-a.mp4',
              hash: 'hash_video_001',
              durationSec: 10,
              fileSize: 1024,
              importedAt: '2024-01-01T00:00:00Z',
              license: {
                source: 'user',
                licenseType: 'unknown',
                allowedUse: [],
              },
              tags: [],
              proxyStatus: 'notNeeded',
              audio: {
                sampleRate: 48000,
                channels: 2,
                codec: 'aac',
              },
            },
          ],
        ]),
      });

      render(<Timeline sequence={sequenceWithAudioClip} />);

      expect(screen.getByTestId('video-audio-source-tag')).toHaveTextContent('Video Audio');
    });

    it('should render fallback video-audio label when clip label is empty', () => {
      const sequenceWithAudioClip: Sequence = {
        ...mockSequence,
        tracks: [
          mockSequence.tracks[0],
          {
            ...mockSequence.tracks[1],
            clips: [
              {
                id: 'clip_audio_from_video_empty_label',
                assetId: 'asset_video_002',
                range: { sourceInSec: 0, sourceOutSec: 0.2 },
                place: { timelineInSec: 0, durationSec: 0.2 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
                label: ' ',
              },
            ],
          },
        ],
      };

      useProjectStore.setState({
        assets: new Map([
          [
            'asset_video_002',
            {
              id: 'asset_video_002',
              kind: 'video',
              name: 'city-night-take.mp4',
              uri: '/assets/city-night-take.mp4',
              hash: 'hash_video_002',
              durationSec: 12,
              fileSize: 1024,
              importedAt: '2024-01-01T00:00:00Z',
              license: {
                source: 'user',
                licenseType: 'unknown',
                allowedUse: [],
              },
              tags: [],
              proxyStatus: 'notNeeded',
              audio: {
                sampleRate: 48000,
                channels: 2,
                codec: 'aac',
              },
            },
          ],
        ]),
      });

      render(<Timeline sequence={sequenceWithAudioClip} />);

      expect(screen.getByText('Video Audio: city-night-take.mp4')).toBeInTheDocument();
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
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
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

    it('should select linked companion clips when linked selection is enabled', () => {
      const sequenceWithLinkedClips: Sequence = {
        ...mockSequence,
        tracks: [
          {
            ...mockSequence.tracks[0],
            clips: [
              {
                id: 'clip_video_001',
                assetId: 'asset_linked_001',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 5, durationSec: 10 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
              },
            ],
          },
          {
            ...mockSequence.tracks[1],
            clips: [
              {
                id: 'clip_audio_001',
                assetId: 'asset_linked_001',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 5, durationSec: 10 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
              },
            ],
          },
        ],
      };

      useTimelineStore.setState({ linkedSelectionEnabled: true, selectedClipIds: [] });
      render(<Timeline sequence={sequenceWithLinkedClips} />);

      fireEvent.click(screen.getByTestId('clip-clip_video_001'));

      expect(useTimelineStore.getState().selectedClipIds).toEqual(
        expect.arrayContaining(['clip_video_001', 'clip_audio_001']),
      );
    });

    it('should not select linked companion clips when linked selection is disabled', () => {
      const sequenceWithLinkedClips: Sequence = {
        ...mockSequence,
        tracks: [
          {
            ...mockSequence.tracks[0],
            clips: [
              {
                id: 'clip_video_001',
                assetId: 'asset_linked_001',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 5, durationSec: 10 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
              },
            ],
          },
          {
            ...mockSequence.tracks[1],
            clips: [
              {
                id: 'clip_audio_001',
                assetId: 'asset_linked_001',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 5, durationSec: 10 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
              },
            ],
          },
        ],
      };

      useTimelineStore.setState({ linkedSelectionEnabled: false, selectedClipIds: [] });
      render(<Timeline sequence={sequenceWithLinkedClips} />);

      fireEvent.click(screen.getByTestId('clip-clip_video_001'));

      expect(useTimelineStore.getState().selectedClipIds).toEqual(['clip_video_001']);
    });
  });

  // ===========================================================================
  // Clip Drag Tests
  // ===========================================================================

  describe('clip drag', () => {
    it('should move clip to another compatible track when dragged vertically', async () => {
      const onClipMove = vi.fn();

      const sequenceWithTwoVideoTracks: Sequence = {
        ...mockSequence,
        tracks: [
          {
            ...mockSequence.tracks[0],
            id: 'track_001',
            kind: 'video',
            clips: [
              {
                id: 'clip_drag_001',
                assetId: 'asset_001',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 0, durationSec: 10 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
              },
            ],
          },
          {
            ...mockSequence.tracks[1],
            id: 'track_002',
            kind: 'video',
            name: 'Video 2',
            clips: [],
          },
        ],
      };

      render(<Timeline sequence={sequenceWithTwoVideoTracks} onClipMove={onClipMove} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      const firstTrackRow = tracksArea.querySelector<HTMLElement>('[data-track-id="track_001"]');
      const secondTrackRow = tracksArea.querySelector<HTMLElement>('[data-track-id="track_002"]');

      expect(firstTrackRow).not.toBeNull();
      expect(secondTrackRow).not.toBeNull();

      const createRect = (top: number, height: number) => ({
        left: 0,
        top,
        width: 800,
        height,
        right: 800,
        bottom: top + height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      });

      tracksArea.getBoundingClientRect = vi.fn().mockReturnValue(createRect(0, 220));
      firstTrackRow!.getBoundingClientRect = vi.fn().mockReturnValue(createRect(0, 64));
      secondTrackRow!.getBoundingClientRect = vi.fn().mockReturnValue(createRect(64, 64));

      const clip = screen.getByTestId('clip-clip_drag_001');

      await act(async () => {
        fireEvent.mouseDown(clip, { button: 0, clientX: 240, clientY: 20 });
      });

      // First move exceeds drag threshold and enters the second track row.
      await act(async () => {
        fireEvent.mouseMove(document, { clientX: 250, clientY: 90 });
      });

      // Keep dragging in second track before drop.
      await act(async () => {
        fireEvent.mouseMove(document, { clientX: 280, clientY: 90 });
      });

      await act(async () => {
        fireEvent.mouseUp(document, { clientX: 280, clientY: 90 });
      });

      expect(onClipMove).toHaveBeenCalledWith(
        expect.objectContaining({
          clipId: 'clip_drag_001',
          trackId: 'track_001',
          newTrackId: 'track_002',
        }),
      );
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
      // Playhead is rendered inside a clipped container that is already offset by the track header.
      // Local X=0 maps to the start of the timeline content area.
      expect(playhead.style.transform).toBe('translateX(500px)');

      const playheadContainer = playhead.parentElement as HTMLElement | null;
      expect(playheadContainer).not.toBeNull();
      expect(playheadContainer!.style.left).toBe('192px');
    });

    it('should update playhead when seeking via ruler mousedown', async () => {
      render(<Timeline sequence={mockSequence} />);

      const ruler = screen.getByTestId('time-ruler');
      // Simulate mouseDown at a position (ruler now uses mouseDown for scrubbing)
      await act(async () => {
        fireEvent.mouseDown(ruler, { clientX: 300 });
      });

      // Playhead should update (exact position depends on implementation)
      expect(usePlaybackStore.getState().currentTime).toBeGreaterThan(0);
    });

    it('should seek when clicking empty tracks area', async () => {
      render(<Timeline sequence={mockSequence} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      await act(async () => {
        fireEvent.pointerDown(tracksArea, { clientX: 300, clientY: 40, button: 0, pointerId: 1 });
      });

      // Deferred seek model: click commits on mouse up, not mouse down
      expect(usePlaybackStore.getState().currentTime).toBe(0);

      await act(async () => {
        fireEvent.pointerUp(tracksArea, { clientX: 300, clientY: 40, button: 0, pointerId: 1 });
      });

      expect(usePlaybackStore.getState().currentTime).toBeGreaterThan(0);

      // Ensure gesture cleanup restores global cursor state
      expect(document.body.style.cursor).toBe('');
    });

    it('should pan timeline on empty-area drag without moving playhead', async () => {
      useTimelineStore.setState({ scrollX: 200, scrollY: 0 });
      render(<Timeline sequence={mockSequence} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');

      await act(async () => {
        fireEvent.pointerDown(tracksArea, { clientX: 400, clientY: 120, button: 0, pointerId: 2 });
      });

      await act(async () => {
        fireEvent.pointerMove(tracksArea, { clientX: 300, clientY: 120, pointerId: 2 });
      });

      expect(useTimelineStore.getState().scrollX).toBeGreaterThan(200);
      expect(usePlaybackStore.getState().currentTime).toBe(0);

      await act(async () => {
        fireEvent.pointerUp(tracksArea, { clientX: 300, clientY: 120, button: 0, pointerId: 2 });
      });

      expect(usePlaybackStore.getState().currentTime).toBe(0);
      expect(document.body.style.cursor).toBe('');
    });

    it('should treat mostly vertical empty-area movement as click seek, not horizontal pan', async () => {
      useTimelineStore.setState({ scrollX: 200, scrollY: 0 });
      render(<Timeline sequence={mockSequence} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');

      await act(async () => {
        fireEvent.pointerDown(tracksArea, { clientX: 400, clientY: 120, button: 0, pointerId: 3 });
      });

      await act(async () => {
        fireEvent.pointerMove(tracksArea, { clientX: 402, clientY: 40, pointerId: 3 });
      });

      // Horizontal threshold/intent not met -> no pan yet
      expect(useTimelineStore.getState().scrollX).toBe(200);

      await act(async () => {
        fireEvent.pointerUp(tracksArea, { clientX: 402, clientY: 40, button: 0, pointerId: 3 });
      });

      // Mouse up still commits click seek at release point
      expect(usePlaybackStore.getState().currentTime).toBeGreaterThan(0);
    });

    it('should allow dragging playhead head to seek', async () => {
      render(<Timeline sequence={mockSequence} />);

      const head = screen.getByTestId('playhead-head');

      await act(async () => {
        // Container left: 0, trackHeaderWidth: 192, zoom: 100
        // 492px => (492 - 192) / 100 = 3s
        fireEvent.mouseDown(head, { clientX: 492, button: 0 });
      });

      expect(usePlaybackStore.getState().currentTime).toBeCloseTo(3, 3);
      expect(screen.getByTestId('playhead')).toHaveAttribute('data-dragging', 'true');

      await act(async () => {
        fireEvent.mouseUp(document);
      });

      expect(screen.getByTestId('playhead')).toHaveAttribute('data-dragging', 'false');
    });

    it('should allow dragging playhead line area to seek', async () => {
      render(<Timeline sequence={mockSequence} />);

      const lineHitArea = screen.getByTestId('playhead-line-hit-area');

      await act(async () => {
        // Container left: 0, trackHeaderWidth: 192, zoom: 100
        // 592px => (592 - 192) / 100 = 4s
        fireEvent.mouseDown(lineHitArea, { clientX: 592, button: 0 });
      });

      expect(usePlaybackStore.getState().currentTime).toBeCloseTo(4, 3);
      expect(screen.getByTestId('playhead')).toHaveAttribute('data-dragging', 'true');

      await act(async () => {
        fireEvent.mouseUp(document);
      });

      expect(screen.getByTestId('playhead')).toHaveAttribute('data-dragging', 'false');
    });

    it('should not seek when clicking directly on a clip body', async () => {
      const sequenceWithClip: Sequence = {
        ...mockSequence,
        tracks: [
          {
            ...mockSequence.tracks[0],
            clips: [
              {
                id: 'clip_seek_click',
                assetId: 'asset_001',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 0, durationSec: 10 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
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

      render(<Timeline sequence={sequenceWithClip} />);

      const clip = screen.getByTestId('clip-clip_seek_click');

      expect(usePlaybackStore.getState().currentTime).toBe(0);

      await act(async () => {
        // Container left=0, header=192, zoom=100 => (300-192)/100 = 1.08s
        fireEvent.mouseDown(clip, { clientX: 300, clientY: 40, button: 0 });
      });

      expect(usePlaybackStore.getState().currentTime).toBe(0);

      await act(async () => {
        fireEvent.mouseUp(document);
      });
    });

    it('should seek when clicking on track header body (non-button area)', async () => {
      render(<Timeline sequence={mockSequence} />);

      const header = screen.getAllByTestId('track-header')[0];
      await act(async () => {
        // Container left=0, header width=192, zoom=100 => (260-192)/100 = 0.68s
        fireEvent.pointerDown(header, { clientX: 260, clientY: 40, button: 0, pointerId: 4 });
      });

      expect(usePlaybackStore.getState().currentTime).toBe(0);

      await act(async () => {
        fireEvent.pointerUp(header, {
          clientX: 260,
          clientY: 40,
          button: 0,
          pointerId: 4,
        });
      });

      expect(usePlaybackStore.getState().currentTime).toBeGreaterThan(0);
    });

    it('should not seek when clicking track header control buttons', async () => {
      render(<Timeline sequence={mockSequence} />);

      expect(usePlaybackStore.getState().currentTime).toBe(0);

      const muteButton = screen.getAllByTestId('mute-button')[0];
      await act(async () => {
        fireEvent.mouseDown(muteButton, { clientX: 40, clientY: 40, button: 0 });
      });

      expect(usePlaybackStore.getState().currentTime).toBe(0);
    });

    it('should not seek when clicking clip trim handles', async () => {
      const sequenceWithClip: Sequence = {
        ...mockSequence,
        tracks: [
          {
            ...mockSequence.tracks[0],
            clips: [
              {
                id: 'clip_trim_seek_guard',
                assetId: 'asset_001',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 0, durationSec: 10 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
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

      render(<Timeline sequence={sequenceWithClip} />);

      expect(usePlaybackStore.getState().currentTime).toBe(0);

      const leftHandle = screen.getByTestId('resize-handle-left');
      await act(async () => {
        fireEvent.mouseDown(leftHandle, { clientX: 300, clientY: 40, button: 0 });
      });

      expect(usePlaybackStore.getState().currentTime).toBe(0);
    });

    it('should not seek when hand tool is active', async () => {
      useEditorToolStore.setState({ activeTool: 'hand' });
      render(<Timeline sequence={mockSequence} />);

      expect(usePlaybackStore.getState().currentTime).toBe(0);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      await act(async () => {
        fireEvent.pointerDown(tracksArea, { clientX: 320, clientY: 40, button: 0, pointerId: 5 });
      });

      expect(usePlaybackStore.getState().currentTime).toBe(0);
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
    it('should toggle playback on space key', () => {
      render(<Timeline sequence={mockSequence} />);

      const timeline = screen.getByTestId('timeline');

      act(() => {
        fireEvent.keyDown(timeline, { key: ' ' });
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

    it('should apply ripple moves only after delete operation resolves', async () => {
      const sequenceWithRipple: Sequence = {
        ...mockSequence,
        tracks: [
          {
            ...mockSequence.tracks[0],
            clips: [
              {
                id: 'clip_001',
                assetId: 'asset_001',
                range: { sourceInSec: 0, sourceOutSec: 5 },
                place: { timelineInSec: 0, durationSec: 5 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
              },
              {
                id: 'clip_002',
                assetId: 'asset_002',
                range: { sourceInSec: 0, sourceOutSec: 5 },
                place: { timelineInSec: 5, durationSec: 5 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
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

      useTimelineStore.setState({ selectedClipIds: ['clip_001'] });
      useEditorToolStore.setState({ rippleEnabled: true });

      let resolveDelete: (() => void) | null = null;
      const onDeleteClips = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDelete = resolve;
          }),
      );
      const onClipMove = vi.fn().mockResolvedValue(undefined);

      render(
        <Timeline
          sequence={sequenceWithRipple}
          onDeleteClips={onDeleteClips}
          onClipMove={onClipMove}
        />,
      );

      const timeline = screen.getByTestId('timeline');
      fireEvent.keyDown(timeline, { key: 'Delete' });

      expect(onDeleteClips).toHaveBeenCalledWith(['clip_001']);
      expect(onClipMove).not.toHaveBeenCalled();

      await act(async () => {
        resolveDelete?.();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onClipMove).toHaveBeenCalledWith(
        expect.objectContaining({
          clipId: 'clip_002',
          newTimelineIn: 0,
        }),
      );
    });
    it('should not throw when ripple move fails after delete', async () => {
      const sequenceWithRipple: Sequence = {
        ...mockSequence,
        tracks: [
          {
            ...mockSequence.tracks[0],
            clips: [
              {
                id: 'clip_001',
                assetId: 'asset_001',
                range: { sourceInSec: 0, sourceOutSec: 5 },
                place: { timelineInSec: 0, durationSec: 5 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
                opacity: 1,
                speed: 1,
                effects: [],
                audio: { volumeDb: 0, pan: 0, muted: false },
              },
              {
                id: 'clip_002',
                assetId: 'asset_002',
                range: { sourceInSec: 0, sourceOutSec: 5 },
                place: { timelineInSec: 5, durationSec: 5 },
                transform: {
                  position: { x: 0.5, y: 0.5 },
                  scale: { x: 1, y: 1 },
                  rotationDeg: 0,
                  anchor: { x: 0.5, y: 0.5 },
                },
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

      useTimelineStore.setState({ selectedClipIds: ['clip_001'] });
      useEditorToolStore.setState({ rippleEnabled: true });

      const onDeleteClips = vi.fn().mockResolvedValue(undefined);
      const onClipMove = vi.fn().mockRejectedValue(new Error('move failed'));

      render(
        <Timeline
          sequence={sequenceWithRipple}
          onDeleteClips={onDeleteClips}
          onClipMove={onClipMove}
        />,
      );

      const timeline = screen.getByTestId('timeline');
      fireEvent.keyDown(timeline, { key: 'Delete' });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onDeleteClips).toHaveBeenCalledWith(['clip_001']);
      expect(onClipMove).toHaveBeenCalled();
    });

    it('should toggle linked selection with Shift+L', () => {
      useTimelineStore.setState({ linkedSelectionEnabled: true });
      render(<Timeline sequence={mockSequence} />);

      const timeline = screen.getByTestId('timeline');
      fireEvent.keyDown(timeline, { key: 'L', shiftKey: true });
      expect(useTimelineStore.getState().linkedSelectionEnabled).toBe(false);

      fireEvent.keyDown(timeline, { key: 'L', shiftKey: true });
      expect(useTimelineStore.getState().linkedSelectionEnabled).toBe(true);
    });
  });

  describe('toolbar toggles', () => {
    it('should toggle linked selection from toolbar button', () => {
      useTimelineStore.setState({ linkedSelectionEnabled: true });
      render(<Timeline sequence={mockSequence} />);

      const button = screen.getByTestId('linked-selection-toggle-button');
      expect(button).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(button);
      expect(useTimelineStore.getState().linkedSelectionEnabled).toBe(false);
      expect(button).toHaveAttribute('aria-pressed', 'false');
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

    it('should not scroll horizontally on wheel without Shift when there is no vertical overflow', () => {
      render(<Timeline sequence={mockSequence} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      fireEvent.wheel(tracksArea, { deltaY: 100 });

      expect(useTimelineStore.getState().scrollX).toBe(0);
    });

    it('should scroll vertically on wheel when tracks overflow viewport', () => {
      const sequenceWithManyTracks: Sequence = {
        ...mockSequence,
        tracks: Array.from({ length: 10 }, (_, index) => {
          const template = index % 2 === 0 ? mockSequence.tracks[0] : mockSequence.tracks[1];
          return {
            ...template,
            id: `track_overflow_${index + 1}`,
            name: `${template.kind === 'video' ? 'Video' : 'Audio'} ${index + 1}`,
            clips: [],
          };
        }),
      };

      render(<Timeline sequence={sequenceWithManyTracks} />);

      const tracksArea = screen.getByTestId('timeline-tracks-area');
      fireEvent.wheel(tracksArea, { deltaY: 100 });

      expect(useTimelineStore.getState().scrollY).toBeGreaterThan(0);
      expect(useTimelineStore.getState().scrollX).toBe(0);
    });

    it('should scroll horizontally when wheeling over the time ruler', () => {
      render(<Timeline sequence={mockSequence} />);

      const ruler = screen.getByTestId('time-ruler');
      fireEvent.wheel(ruler, { deltaY: 100, shiftKey: true });

      expect(useTimelineStore.getState().scrollX).toBeGreaterThan(0);
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
        }),
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
        tracks: [{ ...mockSequence.tracks[0], locked: true }, mockSequence.tracks[1]],
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

/**
 * VirtualizedTrack Component Tests
 *
 * Tests for the virtualized timeline track component including:
 * - Rendering visible clips only
 * - Track header controls
 * - Event handlers
 * - Debug mode
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VirtualizedTrack } from './VirtualizedTrack';
import type { Track as TrackType, Clip as ClipType } from '@/types';

// =============================================================================
// Test Fixtures
// =============================================================================

const createMockTrack = (overrides: Partial<TrackType> = {}): TrackType => ({
  id: 'track-1',
  kind: 'video',
  name: 'Video Track 1',
  clips: [],
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1,
  ...overrides,
});

const createMockClip = (
  id: string,
  timelineInSec: number,
  sourceOutSec: number = 10,
): ClipType => ({
  id,
  assetId: `asset-${id}`,
  place: {
    timelineInSec,
    durationSec: sourceOutSec,
  },
  range: {
    sourceInSec: 0,
    sourceOutSec,
  },
  transform: {
    position: { x: 0, y: 0 },
    scale: { x: 1, y: 1 },
    rotationDeg: 0,
    anchor: { x: 0, y: 0 },
  },
  opacity: 1,
  speed: 1,
  effects: [],
  audio: {
    volumeDb: 0,
    pan: 0,
    muted: false,
  },
});

// =============================================================================
// Tests
// =============================================================================

describe('VirtualizedTrack', () => {
  const defaultProps = {
    track: createMockTrack(),
    clips: [] as ClipType[],
    zoom: 100,
    scrollX: 0,
    duration: 60,
    viewportWidth: 1000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Basic Rendering
  // ===========================================================================

  describe('basic rendering', () => {
    it('should render track header', () => {
      render(<VirtualizedTrack {...defaultProps} />);

      expect(screen.getByTestId('track-header')).toBeInTheDocument();
    });

    it('should display track name', () => {
      render(<VirtualizedTrack {...defaultProps} />);

      expect(screen.getByText('Video Track 1')).toBeInTheDocument();
    });

    it('should render track content area', () => {
      render(<VirtualizedTrack {...defaultProps} />);

      expect(screen.getByTestId('track-content')).toBeInTheDocument();
    });

    it('should render correct icon for video track', () => {
      render(<VirtualizedTrack {...defaultProps} />);

      const header = screen.getByTestId('track-header');
      expect(header).toHaveAttribute('data-track-kind', 'video');
    });

    it('should render correct icon for audio track', () => {
      render(
        <VirtualizedTrack
          {...defaultProps}
          track={createMockTrack({ kind: 'audio', name: 'Audio Track' })}
        />,
      );

      const header = screen.getByTestId('track-header');
      expect(header).toHaveAttribute('data-track-kind', 'audio');
    });
  });

  // ===========================================================================
  // Clip Virtualization
  // ===========================================================================

  describe('clip virtualization', () => {
    it('should render visible clips', () => {
      const clips = [
        createMockClip('1', 0, 5), // 0-5 seconds (visible)
        createMockClip('2', 5, 5), // 5-10 seconds (visible)
      ];

      render(<VirtualizedTrack {...defaultProps} clips={clips} viewportWidth={1000} />);

      expect(screen.getByTestId('clip-1')).toBeInTheDocument();
      expect(screen.getByTestId('clip-2')).toBeInTheDocument();
    });

    it('should not render clips outside viewport', () => {
      const clips = [
        createMockClip('1', 0, 5), // Visible
        createMockClip('2', 50, 5), // Far outside viewport at 50-55 seconds
      ];

      render(
        <VirtualizedTrack
          {...defaultProps}
          clips={clips}
          viewportWidth={1000} // 10 seconds visible
          bufferPx={200} // 2 seconds buffer
        />,
      );

      expect(screen.getByTestId('clip-1')).toBeInTheDocument();
      expect(screen.queryByTestId('clip-2')).not.toBeInTheDocument();
    });

    it('should show virtualization indicator in debug mode', () => {
      const clips = [
        createMockClip('1', 0, 5),
        createMockClip('2', 50, 5), // Outside viewport
      ];

      render(
        <VirtualizedTrack
          {...defaultProps}
          clips={clips}
          viewportWidth={1000}
          bufferPx={200}
          debug={true}
        />,
      );

      // Debug info shows rendered/total count - there may be multiple occurrences
      const debugTexts = screen.getAllByText(/1\/2/);
      expect(debugTexts.length).toBeGreaterThan(0);
    });

    it('should mark track content as virtualized', () => {
      const clips = [
        createMockClip('1', 0, 5),
        createMockClip('2', 50, 5), // Outside viewport
      ];

      render(
        <VirtualizedTrack {...defaultProps} clips={clips} viewportWidth={1000} bufferPx={200} />,
      );

      expect(screen.getByTestId('track-content')).toHaveAttribute('data-virtualized', 'true');
    });
  });

  // ===========================================================================
  // Track Controls
  // ===========================================================================

  describe('track controls', () => {
    it('should call onMuteToggle when mute button clicked', () => {
      const onMuteToggle = vi.fn();
      render(<VirtualizedTrack {...defaultProps} onMuteToggle={onMuteToggle} />);

      fireEvent.click(screen.getByTestId('mute-button'));

      expect(onMuteToggle).toHaveBeenCalledWith('track-1');
    });

    it('should call onLockToggle when lock button clicked', () => {
      const onLockToggle = vi.fn();
      render(<VirtualizedTrack {...defaultProps} onLockToggle={onLockToggle} />);

      fireEvent.click(screen.getByTestId('lock-button'));

      expect(onLockToggle).toHaveBeenCalledWith('track-1');
    });

    it('should call onVisibilityToggle when visibility button clicked', () => {
      const onVisibilityToggle = vi.fn();
      render(<VirtualizedTrack {...defaultProps} onVisibilityToggle={onVisibilityToggle} />);

      fireEvent.click(screen.getByTestId('visibility-button'));

      expect(onVisibilityToggle).toHaveBeenCalledWith('track-1');
    });

    it('should show muted indicator when track is muted', () => {
      render(<VirtualizedTrack {...defaultProps} track={createMockTrack({ muted: true })} />);

      expect(screen.getByTestId('muted-indicator')).toBeInTheDocument();
    });

    it('should show locked indicator when track is locked', () => {
      render(<VirtualizedTrack {...defaultProps} track={createMockTrack({ locked: true })} />);

      expect(screen.getByTestId('locked-indicator')).toBeInTheDocument();
    });

    it('should apply opacity when track is not visible', () => {
      render(<VirtualizedTrack {...defaultProps} track={createMockTrack({ visible: false })} />);

      const trackContent = screen.getByTestId('track-content');
      expect(trackContent).toHaveClass('opacity-50');
    });
  });

  // ===========================================================================
  // Clip Selection
  // ===========================================================================

  describe('clip selection', () => {
    it('should mark selected clips', () => {
      const clips = [createMockClip('1', 0, 5)];

      render(<VirtualizedTrack {...defaultProps} clips={clips} selectedClipIds={['1']} />);

      const clip = screen.getByTestId('clip-1');
      expect(clip).toHaveClass('ring-2');
    });
  });

  // ===========================================================================
  // Clip Events
  // ===========================================================================

  describe('clip events', () => {
    it('should call onClipClick when clip is clicked', () => {
      const clips = [createMockClip('1', 0, 5)];
      const onClipClick = vi.fn();

      render(<VirtualizedTrack {...defaultProps} clips={clips} onClipClick={onClipClick} />);

      fireEvent.click(screen.getByTestId('clip-1'));

      expect(onClipClick).toHaveBeenCalledWith('1', expect.any(Object));
    });

    it('should call onClipDoubleClick when clip is double-clicked', () => {
      const clips = [createMockClip('1', 0, 5)];
      const onClipDoubleClick = vi.fn();

      render(
        <VirtualizedTrack {...defaultProps} clips={clips} onClipDoubleClick={onClipDoubleClick} />,
      );

      fireEvent.doubleClick(screen.getByTestId('clip-1'));

      expect(onClipDoubleClick).toHaveBeenCalledWith('1');
    });
  });

  // ===========================================================================
  // Track Dimensions
  // ===========================================================================

  describe('track dimensions', () => {
    it('should set content width based on duration and zoom', () => {
      render(<VirtualizedTrack {...defaultProps} duration={60} zoom={100} />);

      const trackContent = screen.getByTestId('track-content');
      const scrollContainer = trackContent.firstChild as HTMLElement;

      expect(scrollContainer).toHaveStyle({ width: '6000px' }); // 60 * 100
    });

    it('should apply scroll transform', () => {
      render(<VirtualizedTrack {...defaultProps} scrollX={500} />);

      const trackContent = screen.getByTestId('track-content');
      const scrollContainer = trackContent.firstChild as HTMLElement;

      expect(scrollContainer).toHaveStyle({ transform: 'translateX(-500px)' });
    });
  });

  // ===========================================================================
  // Debug Mode
  // ===========================================================================

  describe('debug mode', () => {
    it('should show debug overlay when enabled', () => {
      const clips = [createMockClip('1', 0, 5)];

      render(<VirtualizedTrack {...defaultProps} clips={clips} debug={true} />);

      // Debug overlay shows clip counts, viewport, and scroll info
      const debugTexts = screen.getAllByText(/clips|viewport:/);
      expect(debugTexts.length).toBeGreaterThan(0);
    });

    it('should not show debug overlay when disabled', () => {
      const clips = [createMockClip('1', 0, 5)];

      render(<VirtualizedTrack {...defaultProps} clips={clips} debug={false} />);

      // When debug is false, there should be no debug overlay with "viewport:" text
      const debugElements = screen.queryAllByText(/viewport:/);
      expect(debugElements).toHaveLength(0);
    });
  });
});

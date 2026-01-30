/**
 * Track Component Tests
 *
 * Tests for the timeline track component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Track } from './Track';
import type { Track as TrackType, Clip as ClipType } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const mockTrack: TrackType = {
  id: 'track_001',
  kind: 'video',
  name: 'Video 1',
  clips: [],
  blendMode: 'normal',
  muted: false,
  locked: false,
  visible: true,
  volume: 1.0,
};

const mockClips: ClipType[] = [
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
  {
    id: 'clip_002',
    assetId: 'asset_002',
    range: { sourceInSec: 0, sourceOutSec: 5 },
    place: { timelineInSec: 15, durationSec: 5 },
    transform: { position: { x: 0.5, y: 0.5 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
  },
];

// Adjacent clips for transition zone testing
const adjacentClips: ClipType[] = [
  {
    id: 'clip_001',
    assetId: 'asset_001',
    range: { sourceInSec: 0, sourceOutSec: 5 },
    place: { timelineInSec: 0, durationSec: 5 },
    transform: { position: { x: 0.5, y: 0.5 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
  },
  {
    id: 'clip_002',
    assetId: 'asset_002',
    range: { sourceInSec: 0, sourceOutSec: 5 },
    place: { timelineInSec: 5, durationSec: 5 }, // Starts exactly where clip_001 ends
    transform: { position: { x: 0.5, y: 0.5 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
  },
  {
    id: 'clip_003',
    assetId: 'asset_003',
    range: { sourceInSec: 0, sourceOutSec: 5 },
    place: { timelineInSec: 10, durationSec: 5 }, // Starts exactly where clip_002 ends
    transform: { position: { x: 0.5, y: 0.5 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
    opacity: 1,
    speed: 1,
    effects: [],
    audio: { volumeDb: 0, pan: 0, muted: false },
  },
];

// =============================================================================
// Tests
// =============================================================================

describe('Track', () => {
  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render track with name', () => {
      render(<Track track={mockTrack} clips={[]} zoom={100} />);
      expect(screen.getByText('Video 1')).toBeInTheDocument();
    });

    it('should render clips in track', () => {
      // viewportWidth must be large enough to include all clips after virtualization
      render(<Track track={mockTrack} clips={mockClips} zoom={100} viewportWidth={3000} />);
      expect(screen.getAllByTestId(/^clip-/)).toHaveLength(2);
    });

    it('should show track type indicator', () => {
      render(<Track track={mockTrack} clips={[]} zoom={100} />);
      // Video track should have video icon or indicator
      expect(screen.getByTestId('track-header')).toBeInTheDocument();
    });

    it('should show muted indicator when track is muted', () => {
      const mutedTrack = { ...mockTrack, muted: true };
      render(<Track track={mutedTrack} clips={[]} zoom={100} />);
      expect(screen.getByTestId('muted-indicator')).toBeInTheDocument();
    });

    it('should show locked indicator when track is locked', () => {
      const lockedTrack = { ...mockTrack, locked: true };
      render(<Track track={lockedTrack} clips={[]} zoom={100} />);
      expect(screen.getByTestId('locked-indicator')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onMuteToggle when mute button is clicked', () => {
      const onMuteToggle = vi.fn();
      render(<Track track={mockTrack} clips={[]} zoom={100} onMuteToggle={onMuteToggle} />);

      fireEvent.click(screen.getByTestId('mute-button'));
      expect(onMuteToggle).toHaveBeenCalledWith('track_001');
    });

    it('should call onLockToggle when lock button is clicked', () => {
      const onLockToggle = vi.fn();
      render(<Track track={mockTrack} clips={[]} zoom={100} onLockToggle={onLockToggle} />);

      fireEvent.click(screen.getByTestId('lock-button'));
      expect(onLockToggle).toHaveBeenCalledWith('track_001');
    });

    it('should call onVisibilityToggle when visibility button is clicked', () => {
      const onVisibilityToggle = vi.fn();
      render(<Track track={mockTrack} clips={[]} zoom={100} onVisibilityToggle={onVisibilityToggle} />);

      fireEvent.click(screen.getByTestId('visibility-button'));
      expect(onVisibilityToggle).toHaveBeenCalledWith('track_001');
    });
  });

  // ===========================================================================
  // Styling Tests
  // ===========================================================================

  describe('styling', () => {
    it('should have reduced opacity when track is hidden', () => {
      const hiddenTrack = { ...mockTrack, visible: false };
      const { container } = render(<Track track={hiddenTrack} clips={[]} zoom={100} />);

      const trackContent = container.querySelector('[data-testid="track-content"]');
      expect(trackContent).toHaveClass('opacity-50');
    });

    it('should apply different colors for different track types', () => {
      const audioTrack: TrackType = { ...mockTrack, id: 'track_002', kind: 'audio', name: 'Audio 1' };
      const { rerender } = render(<Track track={mockTrack} clips={[]} zoom={100} />);

      // Video track
      expect(screen.getByTestId('track-header')).toHaveAttribute('data-track-kind', 'video');

      rerender(<Track track={audioTrack} clips={[]} zoom={100} />);
      expect(screen.getByTestId('track-header')).toHaveAttribute('data-track-kind', 'audio');
    });
  });

  // ===========================================================================
  // TransitionZone Integration Tests
  // ===========================================================================

  describe('transition zones', () => {
    it('should render transition zones between adjacent clips', () => {
      render(
        <Track
          track={mockTrack}
          clips={adjacentClips}
          zoom={100}
          viewportWidth={2000}
          showTransitionZones
        />
      );

      // 3 adjacent clips = 2 transition zones
      const zones = screen.getAllByTestId('transition-zone');
      expect(zones).toHaveLength(2);
    });

    it('should not render transition zones when showTransitionZones is false', () => {
      render(
        <Track
          track={mockTrack}
          clips={adjacentClips}
          zoom={100}
          viewportWidth={2000}
          showTransitionZones={false}
        />
      );

      expect(screen.queryAllByTestId('transition-zone')).toHaveLength(0);
    });

    it('should not render transition zones between non-adjacent clips', () => {
      render(
        <Track
          track={mockTrack}
          clips={mockClips} // These clips have a gap between them
          zoom={100}
          viewportWidth={3000}
          showTransitionZones
        />
      );

      expect(screen.queryAllByTestId('transition-zone')).toHaveLength(0);
    });

    it('should call onTransitionZoneClick when zone is clicked', () => {
      const onTransitionZoneClick = vi.fn();
      render(
        <Track
          track={mockTrack}
          clips={adjacentClips}
          zoom={100}
          viewportWidth={2000}
          showTransitionZones
          onTransitionZoneClick={onTransitionZoneClick}
        />
      );

      const zones = screen.getAllByTestId('transition-zone');
      fireEvent.click(zones[0]);

      expect(onTransitionZoneClick).toHaveBeenCalledWith('clip_001', 'clip_002');
    });

    it('should disable transition zones when track is locked', () => {
      const lockedTrack = { ...mockTrack, locked: true };
      const onTransitionZoneClick = vi.fn();

      render(
        <Track
          track={lockedTrack}
          clips={adjacentClips}
          zoom={100}
          viewportWidth={2000}
          showTransitionZones
          onTransitionZoneClick={onTransitionZoneClick}
        />
      );

      const zones = screen.getAllByTestId('transition-zone');
      fireEvent.click(zones[0]);

      expect(onTransitionZoneClick).not.toHaveBeenCalled();
    });
  });
});

/**
 * Track Component Tests
 *
 * Tests for the timeline track component.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Track } from './Track';
import type { Effect, Track as TrackType, Clip as ClipType } from '@/types';
import { useEditorToolStore } from '@/stores/editorToolStore';
import { useProjectStore } from '@/stores/projectStore';

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
    place: { timelineInSec: 15, durationSec: 5 },
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
];

// Adjacent clips for transition zone testing
const adjacentClips: ClipType[] = [
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
    place: { timelineInSec: 5, durationSec: 5 }, // Starts exactly where clip_001 ends
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
    id: 'clip_003',
    assetId: 'asset_003',
    range: { sourceInSec: 0, sourceOutSec: 5 },
    place: { timelineInSec: 10, durationSec: 5 }, // Starts exactly where clip_002 ends
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
];

const mockTransitionEffect: Effect = {
  id: 'transition_001',
  effectType: 'cross_dissolve',
  enabled: true,
  params: { duration: 1.5 },
  keyframes: {},
  order: 0,
};

function createTrackDataTransfer(payload?: unknown): DataTransfer {
  const data = new Map<string, string>();
  const transfer = {
    effectAllowed: 'all',
    dropEffect: 'none',
    setData: vi.fn((type: string, value: string) => {
      data.set(type, value);
    }),
    getData: vi.fn((type: string) => data.get(type) ?? ''),
    clearData: vi.fn(),
  } as unknown as DataTransfer;

  if (payload !== undefined) {
    const serialized = JSON.stringify(payload);
    transfer.setData('application/x-openreelio-track', serialized);
    transfer.setData('text/plain', serialized);
  }

  return transfer;
}

// =============================================================================
// Tests
// =============================================================================

describe('Track', () => {
  beforeEach(() => {
    act(() => {
      useEditorToolStore.getState().reset();
      useProjectStore.setState({ effects: new Map() });
    });
  });

  afterEach(() => {
    cleanup();
  });

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
      const mutedTrack = { ...mockTrack, kind: 'audio' as const, name: 'Audio 1', muted: true };
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
    it('should call onSwapTracks when a same-kind target is selected from the context menu', () => {
      const onSwapTracks = vi.fn();
      render(
        <Track
          track={mockTrack}
          clips={[]}
          zoom={100}
          swapTargets={[{ trackId: 'track_002', name: 'Video 2' }]}
          onSwapTracks={onSwapTracks}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('track-header'));
      fireEvent.click(screen.getByRole('button', { name: 'Swap with Video 2' }));

      expect(onSwapTracks).toHaveBeenCalledWith('track_001', 'track_002');
    });

    it('should call onSwapTracks when a same-kind track header is dropped onto this track', () => {
      const onSwapTracks = vi.fn();
      const targetTrack = { ...mockTrack, id: 'track_002', name: 'Video 2' };
      const dataTransfer = createTrackDataTransfer({ trackId: 'track_001', kind: 'video' });

      render(
        <Track track={targetTrack} clips={[]} zoom={100} onSwapTracks={onSwapTracks} />,
      );

      fireEvent.dragOver(screen.getByTestId('track-header'), { dataTransfer });
      fireEvent.drop(screen.getByTestId('track-header'), { dataTransfer });

      expect(onSwapTracks).toHaveBeenCalledWith('track_001', 'track_002');
    });

    it('should ignore dropped track headers from a different track kind', () => {
      const onSwapTracks = vi.fn();
      const dataTransfer = createTrackDataTransfer({ trackId: 'track_audio', kind: 'audio' });

      render(<Track track={mockTrack} clips={[]} zoom={100} onSwapTracks={onSwapTracks} />);

      fireEvent.drop(screen.getByTestId('track-header'), { dataTransfer });

      expect(onSwapTracks).not.toHaveBeenCalled();
    });

    it('should write track drag payload when dragging a reorderable header', () => {
      const dataTransfer = createTrackDataTransfer();

      render(<Track track={mockTrack} clips={[]} zoom={100} onSwapTracks={vi.fn()} />);

      fireEvent.dragStart(screen.getByTestId('track-header'), { dataTransfer });

      expect(dataTransfer.setData).toHaveBeenCalledWith(
        'application/x-openreelio-track',
        JSON.stringify({ trackId: 'track_001', kind: 'video' }),
      );
    });

    it('should show a disabled context menu item when no same-kind swap targets exist', () => {
      render(<Track track={mockTrack} clips={[]} zoom={100} />);

      fireEvent.contextMenu(screen.getByTestId('track-header'));

      expect(screen.getByRole('button', { name: 'No other video tracks' })).toBeDisabled();
    });

    it('should call onDeleteTrack when delete is selected from the context menu', () => {
      const onDeleteTrack = vi.fn();
      render(
        <Track
          track={mockTrack}
          clips={[]}
          zoom={100}
          onDeleteTrack={onDeleteTrack}
          canDeleteTrack
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('track-header'));
      fireEvent.click(screen.getByRole('button', { name: 'Delete track' }));

      expect(onDeleteTrack).toHaveBeenCalledWith('track_001');
    });

    it('should disable delete for protected tracks in the context menu', () => {
      render(<Track track={mockTrack} clips={[]} zoom={100} canDeleteTrack={false} />);

      fireEvent.contextMenu(screen.getByTestId('track-header'));

      expect(screen.getByRole('button', { name: 'Delete track' })).toBeDisabled();
    });

    it('should call onMuteToggle when mute button is clicked', () => {
      const onMuteToggle = vi.fn();
      const audioTrack = { ...mockTrack, kind: 'audio' as const, name: 'Audio 1' };
      render(<Track track={audioTrack} clips={[]} zoom={100} onMuteToggle={onMuteToggle} />);

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
      render(
        <Track track={mockTrack} clips={[]} zoom={100} onVisibilityToggle={onVisibilityToggle} />,
      );

      fireEvent.click(screen.getByTestId('visibility-button'));
      expect(onVisibilityToggle).toHaveBeenCalledWith('track_001');
    });

    it('should hide mute control for video tracks', () => {
      render(<Track track={mockTrack} clips={[]} zoom={100} />);

      expect(screen.queryByTestId('mute-button')).not.toBeInTheDocument();
      expect(screen.getByTestId('visibility-button')).toBeInTheDocument();
      expect(screen.getByTestId('lock-button')).toBeInTheDocument();
    });

    it('should hide visibility control for audio tracks', () => {
      const audioTrack = { ...mockTrack, kind: 'audio' as const, name: 'Audio 1' };
      render(<Track track={audioTrack} clips={[]} zoom={100} />);

      expect(screen.getByTestId('mute-button')).toBeInTheDocument();
      expect(screen.queryByTestId('visibility-button')).not.toBeInTheDocument();
      expect(screen.getByTestId('lock-button')).toBeInTheDocument();
    });

    it('should only nest selected clips from the current track', async () => {
      const onCreateCompoundClip = vi.fn();

      render(
        <Track
          track={mockTrack}
          clips={mockClips}
          zoom={100}
          viewportWidth={3000}
          selectedClipIds={['clip_001', 'clip_other_track']}
          onCreateCompoundClip={onCreateCompoundClip}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(await screen.findByRole('button', { name: 'Nest' }));

      expect(onCreateCompoundClip).toHaveBeenCalledWith(['clip_001'], 'track_001');
    });

    it('should call onCopyEffects when selected from the clip context menu', async () => {
      const onCopyEffects = vi.fn();

      render(
        <Track
          track={mockTrack}
          clips={mockClips}
          zoom={100}
          viewportWidth={3000}
          onCopyEffects={onCopyEffects}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(await screen.findByRole('button', { name: /copy effects/i }));

      expect(onCopyEffects).toHaveBeenCalledWith('clip_001', 'track_001');
    });

    it('should paste effects only to the context clip when it is not part of the selection', async () => {
      const onPasteEffects = vi.fn();

      act(() => {
        useEditorToolStore.getState().setEffectsClipboard({
          sourceClipId: 'clip-source',
          effects: [
            {
              id: 'eff-clipboard',
              effectType: 'brightness',
              enabled: true,
              params: {},
              keyframes: {},
              order: 0,
            },
          ],
          transform: {
            position: { x: 0, y: 0 },
            scale: { x: 1, y: 1 },
            rotationDeg: 0,
            anchor: { x: 0.5, y: 0.5 },
          },
          opacity: 1,
          blendMode: 'normal',
          speed: 1,
          reverse: false,
          audio: { volumeDb: 0, pan: 0, muted: false },
        });
      });

      render(
        <Track
          track={mockTrack}
          clips={mockClips}
          zoom={100}
          viewportWidth={3000}
          selectedClipIds={['clip_002']}
          onPasteEffects={onPasteEffects}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(await screen.findByRole('button', { name: /paste effects/i }));

      expect(onPasteEffects).toHaveBeenCalledWith(['clip_001']);
    });

    it('should remove selected attributes through the clip dialog', async () => {
      const onRemoveAttributes = vi.fn();
      const clipsWithEffects = [
        {
          ...mockClips[0],
          effects: ['effect-1'],
        },
      ];

      act(() => {
        useProjectStore.setState({
          effects: new Map([
            [
              'effect-1',
              {
                id: 'effect-1',
                effectType: 'brightness',
                enabled: true,
                params: {},
                keyframes: {},
                order: 0,
              },
            ],
          ]),
        });
      });

      render(
        <Track
          track={mockTrack}
          clips={clipsWithEffects}
          zoom={100}
          viewportWidth={3000}
          onRemoveAttributes={onRemoveAttributes}
        />,
      );

      fireEvent.contextMenu(screen.getByTestId('clip-clip_001'));
      fireEvent.click(await screen.findByRole('button', { name: 'Remove Attributes...' }));
      fireEvent.click(screen.getByLabelText('Brightness'));
      fireEvent.click(screen.getByLabelText('Opacity'));
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      expect(onRemoveAttributes).toHaveBeenCalledWith('clip_001', 'track_001', ['effect-1'], {
        resetTransform: false,
        resetOpacity: true,
        resetBlendMode: false,
        resetSpeed: false,
        resetAudio: false,
      });
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
      const audioTrack: TrackType = {
        ...mockTrack,
        id: 'track_002',
        kind: 'audio',
        name: 'Audio 1',
      };
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
        />,
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
        />,
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
        />,
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
        />,
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
        />,
      );

      const zones = screen.getAllByTestId('transition-zone');
      fireEvent.click(zones[0]);

      expect(onTransitionZoneClick).not.toHaveBeenCalled();
    });

    it('should render an existing transition effect on the junction clip', () => {
      const clipsWithTransition = [
        adjacentClips[0],
        { ...adjacentClips[1], effects: ['transition_001'] },
        adjacentClips[2],
      ];
      act(() => {
        useProjectStore.setState({ effects: new Map([['transition_001', mockTransitionEffect]]) });
      });

      render(
        <Track
          track={mockTrack}
          clips={clipsWithTransition}
          zoom={100}
          viewportWidth={2000}
          showTransitionZones
        />,
      );

      expect(screen.getByTestId('transition-indicator')).toBeInTheDocument();
      expect(screen.getByText('Cross Dissolve')).toBeInTheDocument();
      expect(screen.getByText('1.5s')).toBeInTheDocument();
    });

    it('should remove an existing transition through the remove attributes path', () => {
      const onRemoveAttributes = vi.fn();
      const clipsWithTransition = [
        adjacentClips[0],
        { ...adjacentClips[1], effects: ['transition_001'] },
        adjacentClips[2],
      ];
      act(() => {
        useProjectStore.setState({ effects: new Map([['transition_001', mockTransitionEffect]]) });
      });

      render(
        <Track
          track={mockTrack}
          clips={clipsWithTransition}
          zoom={100}
          viewportWidth={2000}
          showTransitionZones
          onRemoveAttributes={onRemoveAttributes}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /delete transition/i }));

      expect(onRemoveAttributes).toHaveBeenCalledWith(
        'clip_002',
        'track_001',
        ['transition_001'],
        {},
      );
    });
  });
});

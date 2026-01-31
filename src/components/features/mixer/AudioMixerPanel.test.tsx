/**
 * AudioMixerPanel Tests
 *
 * TDD: Tests for the main audio mixer panel container.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AudioMixerPanel } from './AudioMixerPanel';
import type { Track, TrackKind } from '@/types';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock track for testing.
 */
function createMockTrack(overrides: Partial<Track> & { id: string; kind: TrackKind }): Track {
  return {
    name: `Track ${overrides.id}`,
    clips: [],
    blendMode: 'normal',
    muted: false,
    locked: false,
    visible: true,
    volume: 1.0, // Unity gain
    ...overrides,
  };
}

// =============================================================================
// Rendering Tests
// =============================================================================

describe('AudioMixerPanel', () => {
  describe('rendering', () => {
    it('should render without tracks', () => {
      render(<AudioMixerPanel tracks={[]} />);

      expect(screen.getByTestId('audio-mixer-panel')).toBeInTheDocument();
      expect(screen.getByText('No tracks')).toBeInTheDocument();
    });

    it('should render with audio tracks', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio', name: 'Audio 1' }),
        createMockTrack({ id: 'audio_2', kind: 'audio', name: 'Audio 2' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      expect(screen.getByTestId('mixer-channel-audio_1')).toBeInTheDocument();
      expect(screen.getByTestId('mixer-channel-audio_2')).toBeInTheDocument();
    });

    it('should render with video tracks', () => {
      const tracks = [
        createMockTrack({ id: 'video_1', kind: 'video', name: 'Video 1' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      expect(screen.getByTestId('mixer-channel-video_1')).toBeInTheDocument();
    });

    it('should render master channel', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio', name: 'Audio 1' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      expect(screen.getByTestId('mixer-channel-master')).toBeInTheDocument();
    });

    it('should not render caption or overlay tracks', () => {
      const tracks = [
        createMockTrack({ id: 'caption_1', kind: 'caption', name: 'Captions' }),
        createMockTrack({ id: 'overlay_1', kind: 'overlay', name: 'Overlay' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      expect(screen.queryByTestId('mixer-channel-caption_1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mixer-channel-overlay_1')).not.toBeInTheDocument();
    });

    it('should render track name labels', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio', name: 'Voice Over' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      expect(screen.getByText('Voice Over')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<AudioMixerPanel tracks={[]} className="custom-class" />);

      expect(screen.getByTestId('audio-mixer-panel')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Volume Control Tests
  // ===========================================================================

  describe('volume control', () => {
    it('should display correct volume for each track', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio', volume: 1.0 }), // 0 dB
        createMockTrack({ id: 'audio_2', kind: 'audio', volume: 0.5 }), // ~-6 dB
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const channel1 = screen.getByTestId('mixer-channel-audio_1');
      const channel2 = screen.getByTestId('mixer-channel-audio_2');

      // Volume 1.0 (linear) = 0 dB
      expect(within(channel1).getByTestId('volume-display')).toHaveTextContent('0.0 dB');
      // Volume 0.5 (linear) ≈ -6 dB
      expect(within(channel2).getByTestId('volume-display')).toHaveTextContent('-6');
    });

    it('should call onVolumeChange when fader is moved', () => {
      const onVolumeChange = vi.fn();
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio', volume: 1.0 }),
      ];

      render(<AudioMixerPanel tracks={tracks} onVolumeChange={onVolumeChange} />);

      const faderTrack = within(screen.getByTestId('mixer-channel-audio_1'))
        .getByTestId('fader-track');

      // Simulate fader drag
      fireEvent.mouseDown(faderTrack, { clientY: 100 });

      expect(onVolumeChange).toHaveBeenCalledWith('audio_1', expect.any(Number));
    });

    it('should call onMasterVolumeChange when master fader is moved', () => {
      const onMasterVolumeChange = vi.fn();
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(
        <AudioMixerPanel
          tracks={tracks}
          masterVolume={1.0}
          onMasterVolumeChange={onMasterVolumeChange}
        />
      );

      const masterChannel = screen.getByTestId('mixer-channel-master');
      const faderTrack = within(masterChannel).getByTestId('fader-track');

      fireEvent.mouseDown(faderTrack, { clientY: 100 });

      expect(onMasterVolumeChange).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Mute/Solo Tests
  // ===========================================================================

  describe('mute control', () => {
    it('should show muted state for muted tracks', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio', muted: true }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const muteButton = within(screen.getByTestId('mixer-channel-audio_1'))
        .getByTestId('mute-button');

      expect(muteButton).toHaveAttribute('aria-pressed', 'true');
    });

    it('should call onMuteToggle when mute button is clicked', () => {
      const onMuteToggle = vi.fn();
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio', muted: false }),
      ];

      render(<AudioMixerPanel tracks={tracks} onMuteToggle={onMuteToggle} />);

      const muteButton = within(screen.getByTestId('mixer-channel-audio_1'))
        .getByTestId('mute-button');

      fireEvent.click(muteButton);

      expect(onMuteToggle).toHaveBeenCalledWith('audio_1');
    });

    it('should call onMasterMuteToggle when master mute is clicked', () => {
      const onMasterMuteToggle = vi.fn();
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(
        <AudioMixerPanel
          tracks={tracks}
          masterMuted={false}
          onMasterMuteToggle={onMasterMuteToggle}
        />
      );

      const masterChannel = screen.getByTestId('mixer-channel-master');
      const muteButton = within(masterChannel).getByTestId('mute-button');

      fireEvent.click(muteButton);

      expect(onMasterMuteToggle).toHaveBeenCalled();
    });
  });

  describe('solo control', () => {
    it('should show solo button for non-master tracks', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const channel = screen.getByTestId('mixer-channel-audio_1');
      expect(within(channel).getByTestId('solo-button')).toBeInTheDocument();
    });

    it('should not show solo button for master channel', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const masterChannel = screen.getByTestId('mixer-channel-master');
      expect(within(masterChannel).queryByTestId('solo-button')).not.toBeInTheDocument();
    });

    it('should call onSoloToggle when solo button is clicked', () => {
      const onSoloToggle = vi.fn();
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} onSoloToggle={onSoloToggle} />);

      const soloButton = within(screen.getByTestId('mixer-channel-audio_1'))
        .getByTestId('solo-button');

      fireEvent.click(soloButton);

      expect(onSoloToggle).toHaveBeenCalledWith('audio_1');
    });

    it('should show soloed state for soloed tracks', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];
      const soloedTrackIds = new Set(['audio_1']);

      render(<AudioMixerPanel tracks={tracks} soloedTrackIds={soloedTrackIds} />);

      const soloButton = within(screen.getByTestId('mixer-channel-audio_1'))
        .getByTestId('solo-button');

      expect(soloButton).toHaveAttribute('aria-pressed', 'true');
    });
  });

  // ===========================================================================
  // Pan Control Tests
  // ===========================================================================

  describe('pan control', () => {
    it('should render pan control for audio tracks', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const channel = screen.getByTestId('mixer-channel-audio_1');
      expect(within(channel).getByTestId('pan-control')).toBeInTheDocument();
    });

    it('should render pan control for video tracks', () => {
      const tracks = [
        createMockTrack({ id: 'video_1', kind: 'video' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const channel = screen.getByTestId('mixer-channel-video_1');
      expect(within(channel).getByTestId('pan-control')).toBeInTheDocument();
    });

    it('should not render pan control for master channel', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const masterChannel = screen.getByTestId('mixer-channel-master');
      expect(within(masterChannel).queryByTestId('pan-control')).not.toBeInTheDocument();
    });

    it('should call onPanChange when pan control is changed', () => {
      const onPanChange = vi.fn();
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} onPanChange={onPanChange} />);

      const panControl = within(screen.getByTestId('mixer-channel-audio_1'))
        .getByTestId('pan-control');

      fireEvent.change(panControl, { target: { value: '0.5' } });

      expect(onPanChange).toHaveBeenCalledWith('audio_1', 0.5);
    });
  });

  // ===========================================================================
  // Levels Display Tests
  // ===========================================================================

  describe('audio levels', () => {
    it('should display audio meter for each channel', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const channel = screen.getByTestId('mixer-channel-audio_1');
      expect(within(channel).getAllByTestId('meter-bar')).toHaveLength(2); // L + R
    });

    it('should pass levels to channel strip when provided', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];
      const trackLevels = new Map([
        ['audio_1', { left: 0.5, right: 0.5 }],
      ]);

      render(<AudioMixerPanel tracks={tracks} trackLevels={trackLevels} />);

      // The meter should be rendered with the levels
      const channel = screen.getByTestId('mixer-channel-audio_1');
      const meters = within(channel).getAllByTestId('meter-bar');
      expect(meters).toHaveLength(2);
    });

    it('should display master levels when provided', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];
      const masterLevels = { left: 0.7, right: 0.7 };

      render(<AudioMixerPanel tracks={tracks} masterLevels={masterLevels} />);

      const masterChannel = screen.getByTestId('mixer-channel-master');
      const meters = within(masterChannel).getAllByTestId('meter-bar');
      expect(meters).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Channel Type Styling Tests
  // ===========================================================================

  describe('channel type styling', () => {
    it('should apply audio type styling to audio tracks', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const channel = screen.getByTestId('mixer-channel-audio_1');
      expect(channel).toHaveClass('border-green-500');
    });

    it('should apply video type styling to video tracks', () => {
      const tracks = [
        createMockTrack({ id: 'video_1', kind: 'video' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const channel = screen.getByTestId('mixer-channel-video_1');
      expect(channel).toHaveClass('border-blue-500');
    });

    it('should apply master type styling to master channel', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const masterChannel = screen.getByTestId('mixer-channel-master');
      expect(masterChannel).toHaveClass('border-yellow-500');
    });
  });

  // ===========================================================================
  // Disabled State Tests
  // ===========================================================================

  describe('disabled state', () => {
    it('should disable all controls when disabled prop is true', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} disabled={true} />);

      const channel = screen.getByTestId('mixer-channel-audio_1');
      const muteButton = within(channel).getByTestId('mute-button');
      const soloButton = within(channel).getByTestId('solo-button');
      const panControl = within(channel).getByTestId('pan-control');

      expect(muteButton).toBeDisabled();
      expect(soloButton).toBeDisabled();
      expect(panControl).toBeDisabled();
    });
  });

  // ===========================================================================
  // Compact Mode Tests
  // ===========================================================================

  describe('compact mode', () => {
    it('should render in compact mode when compact prop is true', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} compact={true} />);

      expect(screen.getByTestId('audio-mixer-panel')).toHaveClass('compact');
    });
  });

  // ===========================================================================
  // Track Pan State Tests
  // ===========================================================================

  describe('track pan state', () => {
    it('should display track pan when provided in trackPans map', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];
      const trackPans = new Map([['audio_1', 0.5]]);

      render(<AudioMixerPanel tracks={tracks} trackPans={trackPans} />);

      const panControl = within(screen.getByTestId('mixer-channel-audio_1'))
        .getByTestId('pan-control') as HTMLInputElement;

      expect(panControl.value).toBe('0.5');
    });

    it('should default to center pan when not provided', () => {
      const tracks = [
        createMockTrack({ id: 'audio_1', kind: 'audio' }),
      ];

      render(<AudioMixerPanel tracks={tracks} />);

      const panControl = within(screen.getByTestId('mixer-channel-audio_1'))
        .getByTestId('pan-control') as HTMLInputElement;

      expect(panControl.value).toBe('0');
    });
  });

  // ===========================================================================
  // Scroll Behavior Tests
  // ===========================================================================

  describe('scroll behavior', () => {
    it('should have horizontal scroll when many tracks', () => {
      const tracks = Array.from({ length: 10 }, (_, i) =>
        createMockTrack({ id: `audio_${i}`, kind: 'audio', name: `Audio ${i}` })
      );

      render(<AudioMixerPanel tracks={tracks} />);

      const panel = screen.getByTestId('audio-mixer-panel');
      expect(panel).toHaveClass('overflow-x-auto');
    });
  });
});

/**
 * MixerChannelStrip Tests
 *
 * TDD: Tests for the individual channel strip component.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MixerChannelStrip } from './MixerChannelStrip';

// =============================================================================
// Rendering Tests
// =============================================================================

describe('MixerChannelStrip', () => {
  const defaultProps = {
    id: 'test-channel',
    name: 'Test Channel',
    volumeDb: 0,
    pan: 0,
    muted: false,
  };

  describe('rendering', () => {
    it('should render the channel strip', () => {
      render(<MixerChannelStrip {...defaultProps} />);

      expect(screen.getByTestId('mixer-channel-test-channel')).toBeInTheDocument();
    });

    it('should render channel name', () => {
      render(<MixerChannelStrip {...defaultProps} name="Voice Over" />);

      expect(screen.getByText('Voice Over')).toBeInTheDocument();
    });

    it('should render fader', () => {
      render(<MixerChannelStrip {...defaultProps} />);

      expect(screen.getByTestId('fader-track')).toBeInTheDocument();
      expect(screen.getByTestId('fader-thumb')).toBeInTheDocument();
    });

    it('should render stereo meters', () => {
      render(<MixerChannelStrip {...defaultProps} />);

      const meters = screen.getAllByTestId('meter-bar');
      expect(meters).toHaveLength(2); // Left and right
    });

    it('should render volume display', () => {
      render(<MixerChannelStrip {...defaultProps} volumeDb={-12} />);

      expect(screen.getByTestId('volume-display')).toHaveTextContent('-12.0 dB');
    });

    it('should apply custom className', () => {
      render(<MixerChannelStrip {...defaultProps} className="custom-class" />);

      expect(screen.getByTestId('mixer-channel-test-channel')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Channel Type Tests
  // ===========================================================================

  describe('channel type styling', () => {
    it('should apply audio type styling by default', () => {
      render(<MixerChannelStrip {...defaultProps} type="audio" />);

      expect(screen.getByTestId('mixer-channel-test-channel')).toHaveClass('border-green-500');
    });

    it('should apply video type styling', () => {
      render(<MixerChannelStrip {...defaultProps} type="video" />);

      expect(screen.getByTestId('mixer-channel-test-channel')).toHaveClass('border-blue-500');
    });

    it('should apply master type styling', () => {
      render(<MixerChannelStrip {...defaultProps} type="master" />);

      expect(screen.getByTestId('mixer-channel-test-channel')).toHaveClass('border-yellow-500');
    });
  });

  // ===========================================================================
  // Fader Tests
  // ===========================================================================

  describe('fader control', () => {
    it('should call onVolumeChange when fader is moved', () => {
      const onVolumeChange = vi.fn();
      render(<MixerChannelStrip {...defaultProps} onVolumeChange={onVolumeChange} />);

      const faderTrack = screen.getByTestId('fader-track');
      fireEvent.mouseDown(faderTrack, { clientY: 100 });

      expect(onVolumeChange).toHaveBeenCalledWith('test-channel', expect.any(Number));
    });

    it('should reset to unity (0 dB) on double-click', () => {
      const onVolumeChange = vi.fn();
      render(<MixerChannelStrip {...defaultProps} volumeDb={-20} onVolumeChange={onVolumeChange} />);

      const faderTrack = screen.getByTestId('fader-track');
      fireEvent.doubleClick(faderTrack);

      // Should reset to 0 dB
      expect(onVolumeChange).toHaveBeenCalledWith('test-channel', expect.closeTo(0, 1));
    });

    it('should not call onVolumeChange when disabled', () => {
      const onVolumeChange = vi.fn();
      render(<MixerChannelStrip {...defaultProps} disabled={true} onVolumeChange={onVolumeChange} />);

      const faderTrack = screen.getByTestId('fader-track');
      fireEvent.mouseDown(faderTrack, { clientY: 100 });

      expect(onVolumeChange).not.toHaveBeenCalled();
    });

    it('should display unity mark', () => {
      render(<MixerChannelStrip {...defaultProps} />);

      const faderTrack = screen.getByTestId('fader-track');
      // Unity mark should be present (a div with bg-yellow-500/50 class)
      const unityMark = faderTrack.querySelector('.bg-yellow-500\\/50');
      expect(unityMark).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Pan Control Tests
  // ===========================================================================

  describe('pan control', () => {
    it('should render pan control for audio type', () => {
      render(<MixerChannelStrip {...defaultProps} type="audio" />);

      expect(screen.getByTestId('pan-control')).toBeInTheDocument();
    });

    it('should render pan control for video type', () => {
      render(<MixerChannelStrip {...defaultProps} type="video" />);

      expect(screen.getByTestId('pan-control')).toBeInTheDocument();
    });

    it('should not render pan control for master type', () => {
      render(<MixerChannelStrip {...defaultProps} type="master" />);

      expect(screen.queryByTestId('pan-control')).not.toBeInTheDocument();
    });

    it('should display pan value', () => {
      render(<MixerChannelStrip {...defaultProps} pan={-0.5} />);

      expect(screen.getByText('L50')).toBeInTheDocument();
    });

    it('should display center when pan is 0', () => {
      render(<MixerChannelStrip {...defaultProps} pan={0} />);

      expect(screen.getByText('C')).toBeInTheDocument();
    });

    it('should call onPanChange when pan is changed', () => {
      const onPanChange = vi.fn();
      render(<MixerChannelStrip {...defaultProps} onPanChange={onPanChange} />);

      const panControl = screen.getByTestId('pan-control');
      fireEvent.change(panControl, { target: { value: '0.5' } });

      expect(onPanChange).toHaveBeenCalledWith('test-channel', 0.5);
    });

    it('should reset pan to center on double-click', () => {
      const onPanChange = vi.fn();
      render(<MixerChannelStrip {...defaultProps} pan={0.5} onPanChange={onPanChange} />);

      // The pan knob container handles double-click
      const panControl = screen.getByTestId('pan-control').parentElement;
      fireEvent.doubleClick(panControl!);

      expect(onPanChange).toHaveBeenCalledWith('test-channel', 0);
    });
  });

  // ===========================================================================
  // Mute Control Tests
  // ===========================================================================

  describe('mute control', () => {
    it('should render mute button', () => {
      render(<MixerChannelStrip {...defaultProps} />);

      expect(screen.getByTestId('mute-button')).toBeInTheDocument();
    });

    it('should show unmuted state', () => {
      render(<MixerChannelStrip {...defaultProps} muted={false} />);

      const muteButton = screen.getByTestId('mute-button');
      expect(muteButton).toHaveAttribute('aria-pressed', 'false');
      expect(muteButton).toHaveAttribute('aria-label', 'Mute');
    });

    it('should show muted state', () => {
      render(<MixerChannelStrip {...defaultProps} muted={true} />);

      const muteButton = screen.getByTestId('mute-button');
      expect(muteButton).toHaveAttribute('aria-pressed', 'true');
      expect(muteButton).toHaveAttribute('aria-label', 'Unmute');
      expect(muteButton).toHaveClass('bg-red-500');
    });

    it('should call onMuteToggle when clicked', () => {
      const onMuteToggle = vi.fn();
      render(<MixerChannelStrip {...defaultProps} onMuteToggle={onMuteToggle} />);

      fireEvent.click(screen.getByTestId('mute-button'));

      expect(onMuteToggle).toHaveBeenCalledWith('test-channel');
    });

    it('should be disabled when disabled prop is true', () => {
      render(<MixerChannelStrip {...defaultProps} disabled={true} />);

      expect(screen.getByTestId('mute-button')).toBeDisabled();
    });
  });

  // ===========================================================================
  // Solo Control Tests
  // ===========================================================================

  describe('solo control', () => {
    it('should render solo button for non-master channels', () => {
      render(<MixerChannelStrip {...defaultProps} type="audio" onSoloToggle={vi.fn()} />);

      expect(screen.getByTestId('solo-button')).toBeInTheDocument();
    });

    it('should not render solo button for master channel', () => {
      render(<MixerChannelStrip {...defaultProps} type="master" onSoloToggle={vi.fn()} />);

      expect(screen.queryByTestId('solo-button')).not.toBeInTheDocument();
    });

    it('should not render solo button without onSoloToggle', () => {
      render(<MixerChannelStrip {...defaultProps} type="audio" />);

      expect(screen.queryByTestId('solo-button')).not.toBeInTheDocument();
    });

    it('should show unsoloed state', () => {
      render(<MixerChannelStrip {...defaultProps} soloed={false} onSoloToggle={vi.fn()} />);

      const soloButton = screen.getByTestId('solo-button');
      expect(soloButton).toHaveAttribute('aria-pressed', 'false');
    });

    it('should show soloed state', () => {
      render(<MixerChannelStrip {...defaultProps} soloed={true} onSoloToggle={vi.fn()} />);

      const soloButton = screen.getByTestId('solo-button');
      expect(soloButton).toHaveAttribute('aria-pressed', 'true');
      expect(soloButton).toHaveClass('bg-yellow-500');
    });

    it('should call onSoloToggle when clicked', () => {
      const onSoloToggle = vi.fn();
      render(<MixerChannelStrip {...defaultProps} onSoloToggle={onSoloToggle} />);

      fireEvent.click(screen.getByTestId('solo-button'));

      expect(onSoloToggle).toHaveBeenCalledWith('test-channel');
    });
  });

  // ===========================================================================
  // Levels Display Tests
  // ===========================================================================

  describe('levels display', () => {
    it('should pass levels to meters when provided', () => {
      const levels = { left: 0.5, right: 0.5 };
      render(<MixerChannelStrip {...defaultProps} levels={levels} />);

      const meters = screen.getAllByTestId('meter-bar');
      expect(meters).toHaveLength(2);
    });

    it('should pass peak levels when provided', () => {
      const levels = { left: 0.5, right: 0.5, peakLeft: 0.8, peakRight: 0.8 };
      render(<MixerChannelStrip {...defaultProps} levels={levels} />);

      // Peak indicators should be rendered
      const peaks = screen.getAllByTestId('peak-indicator');
      expect(peaks).toHaveLength(2);
    });

    it('should show clipping indicator when level is at max', () => {
      const levels = { left: 0.99, right: 0.99 };
      render(<MixerChannelStrip {...defaultProps} levels={levels} />);

      const clippingIndicators = screen.getAllByTestId('clipping-indicator');
      expect(clippingIndicators).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Volume Display Tests
  // ===========================================================================

  describe('volume display', () => {
    it('should display 0 dB correctly', () => {
      render(<MixerChannelStrip {...defaultProps} volumeDb={0} />);

      expect(screen.getByTestId('volume-display')).toHaveTextContent('0.0 dB');
    });

    it('should display negative dB values', () => {
      render(<MixerChannelStrip {...defaultProps} volumeDb={-18} />);

      expect(screen.getByTestId('volume-display')).toHaveTextContent('-18.0 dB');
    });

    it('should display positive dB values with plus sign', () => {
      render(<MixerChannelStrip {...defaultProps} volumeDb={3} />);

      expect(screen.getByTestId('volume-display')).toHaveTextContent('+3.0 dB');
    });

    it('should display -∞ for very low values', () => {
      render(<MixerChannelStrip {...defaultProps} volumeDb={-60} />);

      expect(screen.getByTestId('volume-display')).toHaveTextContent('-∞');
    });
  });

  // ===========================================================================
  // Compact Mode Tests
  // ===========================================================================

  describe('compact mode', () => {
    it('should render with default height', () => {
      render(<MixerChannelStrip {...defaultProps} compact={false} />);

      // Default fader height is 150
      const faderTrack = screen.getByTestId('fader-track');
      expect(faderTrack).toHaveStyle({ height: '150px' });
    });

    it('should render with compact height', () => {
      render(<MixerChannelStrip {...defaultProps} compact={true} />);

      // Compact fader height is 100
      const faderTrack = screen.getByTestId('fader-track');
      expect(faderTrack).toHaveStyle({ height: '100px' });
    });
  });

  // ===========================================================================
  // Disabled State Tests
  // ===========================================================================

  describe('disabled state', () => {
    it('should disable all controls when disabled', () => {
      render(<MixerChannelStrip {...defaultProps} disabled={true} onSoloToggle={vi.fn()} />);

      expect(screen.getByTestId('mute-button')).toBeDisabled();
      expect(screen.getByTestId('solo-button')).toBeDisabled();
      expect(screen.getByTestId('pan-control')).toBeDisabled();
    });

    it('should apply disabled styling to fader', () => {
      render(<MixerChannelStrip {...defaultProps} disabled={true} />);

      const faderTrack = screen.getByTestId('fader-track');
      expect(faderTrack).toHaveClass('opacity-50');
      expect(faderTrack).toHaveClass('cursor-not-allowed');
    });
  });
});

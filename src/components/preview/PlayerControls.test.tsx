/**
 * PlayerControls Component Tests
 *
 * Tests for the video player control bar with play/pause, seek, volume, etc.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlayerControls } from './PlayerControls';

// =============================================================================
// Tests
// =============================================================================

describe('PlayerControls', () => {
  const defaultProps = {
    currentTime: 0,
    duration: 60,
    isPlaying: false,
    volume: 1,
    isMuted: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render controls container', () => {
      render(<PlayerControls {...defaultProps} />);
      expect(screen.getByTestId('player-controls')).toBeInTheDocument();
    });

    it('should render play button when paused', () => {
      render(<PlayerControls {...defaultProps} isPlaying={false} />);
      expect(screen.getByTestId('play-button')).toBeInTheDocument();
      expect(screen.getByLabelText('Play')).toBeInTheDocument();
    });

    it('should render pause button when playing', () => {
      render(<PlayerControls {...defaultProps} isPlaying={true} />);
      expect(screen.getByTestId('pause-button')).toBeInTheDocument();
      expect(screen.getByLabelText('Pause')).toBeInTheDocument();
    });

    it('should render seek bar', () => {
      render(<PlayerControls {...defaultProps} />);
      expect(screen.getByTestId('seek-bar')).toBeInTheDocument();
    });

    it('should render volume controls', () => {
      render(<PlayerControls {...defaultProps} />);
      expect(screen.getByTestId('volume-button')).toBeInTheDocument();
      expect(screen.getByTestId('volume-slider')).toBeInTheDocument();
    });

    it('should render time display', () => {
      render(<PlayerControls {...defaultProps} currentTime={65} duration={180} />);
      // 1:05 / 3:00
      expect(screen.getByTestId('time-display')).toHaveTextContent('1:05');
      expect(screen.getByTestId('duration-display')).toHaveTextContent('3:00');
    });

    it('should render fullscreen button', () => {
      render(<PlayerControls {...defaultProps} />);
      expect(screen.getByTestId('fullscreen-button')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Play/Pause Tests
  // ===========================================================================

  describe('play/pause', () => {
    it('should call onPlayPause when play button clicked', () => {
      const onPlayPause = vi.fn();
      render(<PlayerControls {...defaultProps} onPlayPause={onPlayPause} />);

      fireEvent.click(screen.getByTestId('play-button'));
      expect(onPlayPause).toHaveBeenCalled();
    });

    it('should call onPlayPause when pause button clicked', () => {
      const onPlayPause = vi.fn();
      render(
        <PlayerControls {...defaultProps} isPlaying={true} onPlayPause={onPlayPause} />
      );

      fireEvent.click(screen.getByTestId('pause-button'));
      expect(onPlayPause).toHaveBeenCalled();
    });

    it('should toggle play/pause on space key', () => {
      const onPlayPause = vi.fn();
      render(<PlayerControls {...defaultProps} onPlayPause={onPlayPause} />);

      const controls = screen.getByTestId('player-controls');
      fireEvent.keyDown(controls, { key: ' ', code: 'Space' });

      expect(onPlayPause).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Seek Tests
  // ===========================================================================

  describe('seeking', () => {
    it('should show current time position on seek bar', () => {
      render(<PlayerControls {...defaultProps} currentTime={30} duration={60} />);

      const seekBar = screen.getByTestId('seek-bar');
      // 30/60 = 50%
      expect(seekBar).toHaveAttribute('aria-valuenow', '30');
      expect(seekBar).toHaveAttribute('aria-valuemax', '60');
    });

    it('should call onSeek when seek bar is clicked', () => {
      const onSeek = vi.fn();
      render(<PlayerControls {...defaultProps} duration={100} onSeek={onSeek} />);

      const seekBar = screen.getByTestId('seek-bar');
      // Simulate click at 50% position
      fireEvent.click(seekBar, {
        clientX: 50,
      });

      expect(onSeek).toHaveBeenCalled();
    });

    it('should seek forward on right arrow key', () => {
      const onSeek = vi.fn();
      render(
        <PlayerControls {...defaultProps} currentTime={10} onSeek={onSeek} />
      );

      const controls = screen.getByTestId('player-controls');
      fireEvent.keyDown(controls, { key: 'ArrowRight' });

      expect(onSeek).toHaveBeenCalled();
    });

    it('should seek backward on left arrow key', () => {
      const onSeek = vi.fn();
      render(
        <PlayerControls {...defaultProps} currentTime={10} onSeek={onSeek} />
      );

      const controls = screen.getByTestId('player-controls');
      fireEvent.keyDown(controls, { key: 'ArrowLeft' });

      expect(onSeek).toHaveBeenCalled();
    });

    it('should jump to start on Home key', () => {
      const onSeek = vi.fn();
      render(
        <PlayerControls {...defaultProps} currentTime={30} onSeek={onSeek} />
      );

      const controls = screen.getByTestId('player-controls');
      fireEvent.keyDown(controls, { key: 'Home' });

      expect(onSeek).toHaveBeenCalledWith(0);
    });

    it('should jump to end on End key', () => {
      const onSeek = vi.fn();
      render(
        <PlayerControls {...defaultProps} currentTime={30} duration={60} onSeek={onSeek} />
      );

      const controls = screen.getByTestId('player-controls');
      fireEvent.keyDown(controls, { key: 'End' });

      expect(onSeek).toHaveBeenCalledWith(60);
    });
  });

  // ===========================================================================
  // Volume Tests
  // ===========================================================================

  describe('volume', () => {
    it('should show volume icon when not muted', () => {
      render(<PlayerControls {...defaultProps} volume={0.5} isMuted={false} />);
      expect(screen.getByTestId('volume-icon')).toBeInTheDocument();
    });

    it('should show mute icon when muted', () => {
      render(<PlayerControls {...defaultProps} isMuted={true} />);
      expect(screen.getByTestId('mute-icon')).toBeInTheDocument();
    });

    it('should call onMuteToggle when volume button clicked', () => {
      const onMuteToggle = vi.fn();
      render(<PlayerControls {...defaultProps} onMuteToggle={onMuteToggle} />);

      fireEvent.click(screen.getByTestId('volume-button'));
      expect(onMuteToggle).toHaveBeenCalled();
    });

    it('should call onVolumeChange when volume slider changes', () => {
      const onVolumeChange = vi.fn();
      render(<PlayerControls {...defaultProps} onVolumeChange={onVolumeChange} />);

      const volumeSlider = screen.getByTestId('volume-slider');
      fireEvent.change(volumeSlider, { target: { value: '0.5' } });

      expect(onVolumeChange).toHaveBeenCalledWith(0.5);
    });

    it('should toggle mute on M key', () => {
      const onMuteToggle = vi.fn();
      render(<PlayerControls {...defaultProps} onMuteToggle={onMuteToggle} />);

      const controls = screen.getByTestId('player-controls');
      fireEvent.keyDown(controls, { key: 'm' });

      expect(onMuteToggle).toHaveBeenCalled();
    });

    it('should increase volume on up arrow key', () => {
      const onVolumeChange = vi.fn();
      render(
        <PlayerControls {...defaultProps} volume={0.5} onVolumeChange={onVolumeChange} />
      );

      const controls = screen.getByTestId('player-controls');
      fireEvent.keyDown(controls, { key: 'ArrowUp' });

      expect(onVolumeChange).toHaveBeenCalled();
    });

    it('should decrease volume on down arrow key', () => {
      const onVolumeChange = vi.fn();
      render(
        <PlayerControls {...defaultProps} volume={0.5} onVolumeChange={onVolumeChange} />
      );

      const controls = screen.getByTestId('player-controls');
      fireEvent.keyDown(controls, { key: 'ArrowDown' });

      expect(onVolumeChange).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Fullscreen Tests
  // ===========================================================================

  describe('fullscreen', () => {
    it('should call onFullscreenToggle when fullscreen button clicked', () => {
      const onFullscreenToggle = vi.fn();
      render(
        <PlayerControls {...defaultProps} onFullscreenToggle={onFullscreenToggle} />
      );

      fireEvent.click(screen.getByTestId('fullscreen-button'));
      expect(onFullscreenToggle).toHaveBeenCalled();
    });

    it('should show fullscreen icon when not fullscreen', () => {
      render(<PlayerControls {...defaultProps} isFullscreen={false} />);
      expect(screen.getByTestId('fullscreen-enter-icon')).toBeInTheDocument();
    });

    it('should show exit fullscreen icon when in fullscreen', () => {
      render(<PlayerControls {...defaultProps} isFullscreen={true} />);
      expect(screen.getByTestId('fullscreen-exit-icon')).toBeInTheDocument();
    });

    it('should toggle fullscreen on F key', () => {
      const onFullscreenToggle = vi.fn();
      render(
        <PlayerControls {...defaultProps} onFullscreenToggle={onFullscreenToggle} />
      );

      const controls = screen.getByTestId('player-controls');
      fireEvent.keyDown(controls, { key: 'f' });

      expect(onFullscreenToggle).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Buffer Progress Tests
  // ===========================================================================

  describe('buffer progress', () => {
    it('should display buffer progress on seek bar', () => {
      render(
        <PlayerControls {...defaultProps} buffered={30} duration={60} />
      );

      const bufferBar = screen.getByTestId('buffer-bar');
      expect(bufferBar).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Skip Buttons Tests
  // ===========================================================================

  describe('skip buttons', () => {
    it('should render skip backward button', () => {
      render(<PlayerControls {...defaultProps} />);
      expect(screen.getByTestId('skip-backward-button')).toBeInTheDocument();
    });

    it('should render skip forward button', () => {
      render(<PlayerControls {...defaultProps} />);
      expect(screen.getByTestId('skip-forward-button')).toBeInTheDocument();
    });

    it('should call onSeek with -10s when skip backward clicked', () => {
      const onSeek = vi.fn();
      render(
        <PlayerControls {...defaultProps} currentTime={20} onSeek={onSeek} />
      );

      fireEvent.click(screen.getByTestId('skip-backward-button'));
      expect(onSeek).toHaveBeenCalledWith(10);
    });

    it('should call onSeek with +10s when skip forward clicked', () => {
      const onSeek = vi.fn();
      render(
        <PlayerControls {...defaultProps} currentTime={20} duration={60} onSeek={onSeek} />
      );

      fireEvent.click(screen.getByTestId('skip-forward-button'));
      expect(onSeek).toHaveBeenCalledWith(30);
    });

    it('should not go below 0 when skipping backward', () => {
      const onSeek = vi.fn();
      render(
        <PlayerControls {...defaultProps} currentTime={5} onSeek={onSeek} />
      );

      fireEvent.click(screen.getByTestId('skip-backward-button'));
      expect(onSeek).toHaveBeenCalledWith(0);
    });

    it('should not exceed duration when skipping forward', () => {
      const onSeek = vi.fn();
      render(
        <PlayerControls {...defaultProps} currentTime={55} duration={60} onSeek={onSeek} />
      );

      fireEvent.click(screen.getByTestId('skip-forward-button'));
      expect(onSeek).toHaveBeenCalledWith(60);
    });
  });

  // ===========================================================================
  // Time Format Tests
  // ===========================================================================

  describe('time formatting', () => {
    it('should format seconds correctly', () => {
      render(<PlayerControls {...defaultProps} currentTime={45} duration={60} />);
      expect(screen.getByTestId('time-display')).toHaveTextContent('0:45');
    });

    it('should format minutes correctly', () => {
      render(<PlayerControls {...defaultProps} currentTime={125} duration={300} />);
      expect(screen.getByTestId('time-display')).toHaveTextContent('2:05');
    });

    it('should format hours correctly', () => {
      render(<PlayerControls {...defaultProps} currentTime={3725} duration={7200} />);
      // 1:02:05
      expect(screen.getByTestId('time-display')).toHaveTextContent('1:02:05');
    });

    it('should handle zero duration gracefully', () => {
      render(<PlayerControls {...defaultProps} currentTime={0} duration={0} />);
      expect(screen.getByTestId('time-display')).toHaveTextContent('0:00');
      expect(screen.getByTestId('duration-display')).toHaveTextContent('0:00');
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have proper aria labels on all buttons', () => {
      render(<PlayerControls {...defaultProps} />);

      expect(screen.getByLabelText('Play')).toBeInTheDocument();
      expect(screen.getByLabelText('Skip backward 10 seconds')).toBeInTheDocument();
      expect(screen.getByLabelText('Skip forward 10 seconds')).toBeInTheDocument();
      expect(screen.getByLabelText('Toggle mute')).toBeInTheDocument();
      expect(screen.getByLabelText('Toggle fullscreen')).toBeInTheDocument();
    });

    it('should have proper aria labels on seek bar', () => {
      render(<PlayerControls {...defaultProps} currentTime={30} duration={60} />);

      const seekBar = screen.getByTestId('seek-bar');
      expect(seekBar).toHaveAttribute('role', 'slider');
      expect(seekBar).toHaveAttribute('aria-label', 'Seek');
    });

    it('should have proper aria labels on volume slider', () => {
      render(<PlayerControls {...defaultProps} volume={0.5} />);

      const volumeSlider = screen.getByTestId('volume-slider');
      expect(volumeSlider).toHaveAttribute('aria-label', 'Volume');
    });
  });

  // ===========================================================================
  // Disabled State Tests
  // ===========================================================================

  describe('disabled state', () => {
    it('should disable all controls when disabled prop is true', () => {
      render(<PlayerControls {...defaultProps} disabled={true} />);

      expect(screen.getByTestId('play-button')).toBeDisabled();
      expect(screen.getByTestId('skip-backward-button')).toBeDisabled();
      expect(screen.getByTestId('skip-forward-button')).toBeDisabled();
      expect(screen.getByTestId('volume-button')).toBeDisabled();
      expect(screen.getByTestId('fullscreen-button')).toBeDisabled();
    });

    it('should not call callbacks when disabled', () => {
      const onPlayPause = vi.fn();
      const onSeek = vi.fn();
      render(
        <PlayerControls
          {...defaultProps}
          disabled={true}
          onPlayPause={onPlayPause}
          onSeek={onSeek}
        />
      );

      fireEvent.click(screen.getByTestId('play-button'));
      fireEvent.click(screen.getByTestId('skip-forward-button'));

      expect(onPlayPause).not.toHaveBeenCalled();
      expect(onSeek).not.toHaveBeenCalled();
    });
  });
});

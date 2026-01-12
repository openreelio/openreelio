/**
 * PlaybackButtons Component Tests
 *
 * Tests for playback control buttons (play, pause, skip).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlaybackButtons } from './PlaybackButtons';

// =============================================================================
// Tests
// =============================================================================

describe('PlaybackButtons', () => {
  const defaultProps = {
    isPlaying: false,
    currentTime: 30,
    duration: 120,
  };

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render playback buttons container', () => {
      render(<PlaybackButtons {...defaultProps} />);
      expect(screen.getByTestId('playback-buttons')).toBeInTheDocument();
    });

    it('should render play button when not playing', () => {
      render(<PlaybackButtons {...defaultProps} isPlaying={false} />);
      expect(screen.getByTestId('play-button')).toBeInTheDocument();
    });

    it('should render pause button when playing', () => {
      render(<PlaybackButtons {...defaultProps} isPlaying={true} />);
      expect(screen.getByTestId('pause-button')).toBeInTheDocument();
    });

    it('should render skip backward button', () => {
      render(<PlaybackButtons {...defaultProps} />);
      expect(screen.getByTestId('skip-backward-button')).toBeInTheDocument();
    });

    it('should render skip forward button', () => {
      render(<PlaybackButtons {...defaultProps} />);
      expect(screen.getByTestId('skip-forward-button')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onPlayPause when play button clicked', () => {
      const onPlayPause = vi.fn();
      render(<PlaybackButtons {...defaultProps} onPlayPause={onPlayPause} />);

      fireEvent.click(screen.getByTestId('play-button'));

      expect(onPlayPause).toHaveBeenCalled();
    });

    it('should call onPlayPause when pause button clicked', () => {
      const onPlayPause = vi.fn();
      render(<PlaybackButtons {...defaultProps} isPlaying={true} onPlayPause={onPlayPause} />);

      fireEvent.click(screen.getByTestId('pause-button'));

      expect(onPlayPause).toHaveBeenCalled();
    });

    it('should call onSeek with reduced time when skip backward clicked', () => {
      const onSeek = vi.fn();
      render(<PlaybackButtons {...defaultProps} currentTime={30} onSeek={onSeek} />);

      fireEvent.click(screen.getByTestId('skip-backward-button'));

      // Default skip is 10 seconds: 30 - 10 = 20
      expect(onSeek).toHaveBeenCalledWith(20);
    });

    it('should not go below 0 when skipping backward', () => {
      const onSeek = vi.fn();
      render(<PlaybackButtons {...defaultProps} currentTime={5} onSeek={onSeek} />);

      fireEvent.click(screen.getByTestId('skip-backward-button'));

      expect(onSeek).toHaveBeenCalledWith(0);
    });

    it('should call onSeek with increased time when skip forward clicked', () => {
      const onSeek = vi.fn();
      render(<PlaybackButtons {...defaultProps} currentTime={30} duration={120} onSeek={onSeek} />);

      fireEvent.click(screen.getByTestId('skip-forward-button'));

      // Default skip is 10 seconds: 30 + 10 = 40
      expect(onSeek).toHaveBeenCalledWith(40);
    });

    it('should not exceed duration when skipping forward', () => {
      const onSeek = vi.fn();
      render(<PlaybackButtons {...defaultProps} currentTime={115} duration={120} onSeek={onSeek} />);

      fireEvent.click(screen.getByTestId('skip-forward-button'));

      expect(onSeek).toHaveBeenCalledWith(120);
    });

    it('should not call handlers when disabled', () => {
      const onPlayPause = vi.fn();
      const onSeek = vi.fn();
      render(
        <PlaybackButtons
          {...defaultProps}
          onPlayPause={onPlayPause}
          onSeek={onSeek}
          disabled
        />
      );

      fireEvent.click(screen.getByTestId('play-button'));
      fireEvent.click(screen.getByTestId('skip-backward-button'));
      fireEvent.click(screen.getByTestId('skip-forward-button'));

      expect(onPlayPause).not.toHaveBeenCalled();
      expect(onSeek).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have aria-label on play button', () => {
      render(<PlaybackButtons {...defaultProps} />);
      expect(screen.getByTestId('play-button')).toHaveAttribute('aria-label', 'Play');
    });

    it('should have aria-label on pause button', () => {
      render(<PlaybackButtons {...defaultProps} isPlaying={true} />);
      expect(screen.getByTestId('pause-button')).toHaveAttribute('aria-label', 'Pause');
    });

    it('should have aria-label on skip buttons', () => {
      render(<PlaybackButtons {...defaultProps} />);
      expect(screen.getByTestId('skip-backward-button')).toHaveAttribute(
        'aria-label',
        'Skip backward 10 seconds'
      );
      expect(screen.getByTestId('skip-forward-button')).toHaveAttribute(
        'aria-label',
        'Skip forward 10 seconds'
      );
    });
  });
});

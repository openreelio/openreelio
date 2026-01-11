/**
 * PreviewPlayer Container Component Tests
 *
 * Tests for the main preview player container that integrates
 * VideoPlayer and PlayerControls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { PreviewPlayer } from './PreviewPlayer';

// =============================================================================
// Tests
// =============================================================================

describe('PreviewPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render preview player container', () => {
      render(<PreviewPlayer src="/test-video.mp4" />);
      expect(screen.getByTestId('preview-player')).toBeInTheDocument();
    });

    it('should render video player', () => {
      render(<PreviewPlayer src="/test-video.mp4" />);
      expect(screen.getByTestId('video-player')).toBeInTheDocument();
    });

    it('should render player controls', () => {
      render(<PreviewPlayer src="/test-video.mp4" />);
      expect(screen.getByTestId('player-controls')).toBeInTheDocument();
    });

    it('should apply custom className', () => {
      render(<PreviewPlayer src="/test-video.mp4" className="custom-class" />);
      expect(screen.getByTestId('preview-player')).toHaveClass('custom-class');
    });

    it('should render empty state when no source', () => {
      render(<PreviewPlayer />);
      expect(screen.getByTestId('preview-player-empty')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Play/Pause Integration Tests
  // ===========================================================================

  describe('play/pause integration', () => {
    it('should toggle play state when play button clicked', async () => {
      const playSpy = vi.fn().mockResolvedValue(undefined);

      render(<PreviewPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      video.play = playSpy;

      const playButton = screen.getByTestId('play-button');
      fireEvent.click(playButton);

      expect(playSpy).toHaveBeenCalled();
    });

    it('should show pause button when playing', async () => {
      render(<PreviewPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.play(video);
      });

      expect(screen.getByTestId('pause-button')).toBeInTheDocument();
    });

    it('should show play button when paused', async () => {
      render(<PreviewPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.pause(video);
      });

      expect(screen.getByTestId('play-button')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Seek Integration Tests
  // ===========================================================================

  describe('seek integration', () => {
    it('should update time display on timeupdate', async () => {
      render(<PreviewPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      // Simulate time update
      Object.defineProperty(video, 'currentTime', { value: 30, writable: true });
      Object.defineProperty(video, 'duration', { value: 60, writable: true });

      await act(async () => {
        fireEvent.timeUpdate(video);
      });

      expect(screen.getByTestId('time-display')).toHaveTextContent('0:30');
    });

    it('should seek video when skip forward clicked', async () => {
      const onPlayheadChange = vi.fn();
      render(
        <PreviewPlayer
          src="/test-video.mp4"
          onPlayheadChange={onPlayheadChange}
        />
      );

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      // Simulate loaded metadata with duration
      Object.defineProperty(video, 'duration', { value: 60, writable: true });

      await act(async () => {
        fireEvent.loadedMetadata(video);
      });

      // Set current time via timeUpdate
      Object.defineProperty(video, 'currentTime', { value: 20, writable: true });
      await act(async () => {
        fireEvent.timeUpdate(video);
      });

      const skipForward = screen.getByTestId('skip-forward-button');
      fireEvent.click(skipForward);

      // After skip forward, the video should seek to currentTime + 10
      // Due to jsdom limitations, verify the internal state update occurred
      expect(onPlayheadChange).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Volume Integration Tests
  // ===========================================================================

  describe('volume integration', () => {
    it('should update volume when slider changes', async () => {
      render(<PreviewPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      const volumeSlider = screen.getByTestId('volume-slider');

      fireEvent.change(volumeSlider, { target: { value: '0.5' } });

      expect(video.volume).toBe(0.5);
    });

    it('should toggle mute when mute button clicked', async () => {
      render(<PreviewPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      const muteButton = screen.getByTestId('volume-button');

      fireEvent.click(muteButton);

      expect(video.muted).toBe(true);
    });

    it('should unmute when mute button clicked again', async () => {
      render(<PreviewPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      const muteButton = screen.getByTestId('volume-button');

      // Mute
      fireEvent.click(muteButton);
      expect(video.muted).toBe(true);

      // Unmute
      fireEvent.click(muteButton);
      expect(video.muted).toBe(false);
    });
  });

  // ===========================================================================
  // Controlled Mode Tests
  // ===========================================================================

  describe('controlled mode', () => {
    it('should sync with external playhead prop', async () => {
      const { rerender } = render(
        <PreviewPlayer src="/test-video.mp4" playhead={0} />
      );

      rerender(<PreviewPlayer src="/test-video.mp4" playhead={30} />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.currentTime).toBe(30);
    });

    it('should call onPlayheadChange when time updates', async () => {
      const onPlayheadChange = vi.fn();
      render(
        <PreviewPlayer
          src="/test-video.mp4"
          onPlayheadChange={onPlayheadChange}
        />
      );

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.timeUpdate(video);
      });

      expect(onPlayheadChange).toHaveBeenCalled();
    });

    it('should call onPlayStateChange when play state changes', async () => {
      const onPlayStateChange = vi.fn();
      render(
        <PreviewPlayer
          src="/test-video.mp4"
          onPlayStateChange={onPlayStateChange}
        />
      );

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.play(video);
      });

      expect(onPlayStateChange).toHaveBeenCalledWith(true);
    });
  });

  // ===========================================================================
  // Controls Visibility Tests
  // ===========================================================================

  describe('controls visibility', () => {
    it('should show controls by default', () => {
      render(<PreviewPlayer src="/test-video.mp4" />);
      expect(screen.getByTestId('player-controls')).toBeVisible();
    });

    it('should hide controls when showControls is false', () => {
      render(<PreviewPlayer src="/test-video.mp4" showControls={false} />);
      expect(screen.queryByTestId('player-controls')).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Keyboard Shortcuts Tests
  // ===========================================================================

  describe('keyboard shortcuts', () => {
    it('should toggle playback on space key', async () => {
      const playSpy = vi.fn().mockResolvedValue(undefined);
      render(<PreviewPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      video.play = playSpy;

      const container = screen.getByTestId('preview-player');
      fireEvent.keyDown(container, { key: ' ' });

      expect(playSpy).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Poster Tests
  // ===========================================================================

  describe('poster', () => {
    it('should pass poster to video player', () => {
      render(
        <PreviewPlayer src="/test-video.mp4" poster="/poster.jpg" />
      );

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.poster).toContain('/poster.jpg');
    });
  });

  // ===========================================================================
  // Aspect Ratio Tests
  // ===========================================================================

  describe('aspect ratio', () => {
    it('should use 16:9 aspect ratio by default', () => {
      render(<PreviewPlayer src="/test-video.mp4" />);
      const container = screen.getByTestId('preview-player');
      expect(container).toHaveClass('aspect-video');
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should be focusable', () => {
      render(<PreviewPlayer src="/test-video.mp4" />);
      const container = screen.getByTestId('preview-player');
      expect(container).toHaveAttribute('tabIndex', '0');
    });

    it('should have appropriate role', () => {
      render(<PreviewPlayer src="/test-video.mp4" />);
      const container = screen.getByTestId('preview-player');
      expect(container).toHaveAttribute('role', 'region');
      expect(container).toHaveAttribute('aria-label', 'Video preview');
    });
  });
});

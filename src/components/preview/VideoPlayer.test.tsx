/**
 * VideoPlayer Component Tests
 *
 * Tests for the core video player component that handles video playback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { VideoPlayer } from './VideoPlayer';

// =============================================================================
// Tests
// =============================================================================

describe('VideoPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render video player container', () => {
      render(<VideoPlayer src="/test-video.mp4" />);
      expect(screen.getByTestId('video-player')).toBeInTheDocument();
    });

    it('should render video element', () => {
      render(<VideoPlayer src="/test-video.mp4" />);
      expect(screen.getByTestId('video-element')).toBeInTheDocument();
    });

    it('should set video source correctly', () => {
      render(<VideoPlayer src="/test-video.mp4" />);
      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.src).toContain('/test-video.mp4');
    });

    it('should render poster image when provided', () => {
      render(<VideoPlayer src="/test-video.mp4" poster="/poster.jpg" />);
      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.poster).toContain('/poster.jpg');
    });

    it('should apply custom className', () => {
      render(<VideoPlayer src="/test-video.mp4" className="custom-class" />);
      expect(screen.getByTestId('video-player')).toHaveClass('custom-class');
    });
  });

  // ===========================================================================
  // Playback Control Tests
  // ===========================================================================

  describe('playback control', () => {
    it('should start paused by default', () => {
      render(<VideoPlayer src="/test-video.mp4" />);
      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.paused).toBe(true);
    });

    it('should attempt autoplay when autoPlay prop is true', async () => {
      // Mock play method to return a promise
      const playSpy = vi.fn().mockResolvedValue(undefined);

      render(<VideoPlayer src="/test-video.mp4" autoPlay />);
      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      // Replace play method with spy before triggering canPlay
      video.play = playSpy;

      // Trigger canplay event
      await act(async () => {
        fireEvent.canPlay(video);
      });

      expect(playSpy).toHaveBeenCalled();
    });

    it('should play video when play is called', async () => {
      const onPlayStateChange = vi.fn();
      render(
        <VideoPlayer
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

    it('should pause video when pause is called', async () => {
      const onPlayStateChange = vi.fn();
      render(
        <VideoPlayer
          src="/test-video.mp4"
          onPlayStateChange={onPlayStateChange}
        />
      );

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.pause(video);
      });

      expect(onPlayStateChange).toHaveBeenCalledWith(false);
    });
  });

  // ===========================================================================
  // Time Update Tests
  // ===========================================================================

  describe('time updates', () => {
    it('should call onTimeUpdate when video time changes', async () => {
      const onTimeUpdate = vi.fn();
      render(
        <VideoPlayer src="/test-video.mp4" onTimeUpdate={onTimeUpdate} />
      );

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        // Simulate timeupdate event
        fireEvent.timeUpdate(video);
      });

      expect(onTimeUpdate).toHaveBeenCalled();
    });

    it('should seek to specified time when currentTime prop changes', async () => {
      const { rerender } = render(
        <VideoPlayer src="/test-video.mp4" currentTime={0} />
      );

      rerender(<VideoPlayer src="/test-video.mp4" currentTime={30} />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.currentTime).toBe(30);
    });

    it('should call onDurationChange when duration is known', async () => {
      const onDurationChange = vi.fn();
      render(
        <VideoPlayer
          src="/test-video.mp4"
          onDurationChange={onDurationChange}
        />
      );

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.loadedMetadata(video);
      });

      expect(onDurationChange).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Volume Control Tests
  // ===========================================================================

  describe('volume control', () => {
    it('should set initial volume', () => {
      render(<VideoPlayer src="/test-video.mp4" volume={0.5} />);
      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.volume).toBe(0.5);
    });

    it('should mute video when muted prop is true', () => {
      render(<VideoPlayer src="/test-video.mp4" muted />);
      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.muted).toBe(true);
    });

    it('should update volume when prop changes', () => {
      const { rerender } = render(
        <VideoPlayer src="/test-video.mp4" volume={1} />
      );

      rerender(<VideoPlayer src="/test-video.mp4" volume={0.3} />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.volume).toBe(0.3);
    });
  });

  // ===========================================================================
  // Playback Rate Tests
  // ===========================================================================

  describe('playback rate', () => {
    it('should set playback rate', () => {
      render(<VideoPlayer src="/test-video.mp4" playbackRate={1.5} />);
      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.playbackRate).toBe(1.5);
    });

    it('should update playback rate when prop changes', () => {
      const { rerender } = render(
        <VideoPlayer src="/test-video.mp4" playbackRate={1} />
      );

      rerender(<VideoPlayer src="/test-video.mp4" playbackRate={2} />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.playbackRate).toBe(2);
    });
  });

  // ===========================================================================
  // Loading & Error States Tests
  // ===========================================================================

  describe('loading and error states', () => {
    it('should show loading state while video is loading', () => {
      render(<VideoPlayer src="/test-video.mp4" />);
      expect(screen.getByTestId('video-loading')).toBeInTheDocument();
    });

    it('should hide loading state when video is ready', async () => {
      render(<VideoPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.canPlay(video);
      });

      expect(screen.queryByTestId('video-loading')).not.toBeInTheDocument();
    });

    it('should call onError when video fails to load', async () => {
      const onError = vi.fn();
      render(<VideoPlayer src="/test-video.mp4" onError={onError} />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.error(video);
      });

      expect(onError).toHaveBeenCalled();
    });

    it('should show error state when video fails to load', async () => {
      render(<VideoPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.error(video);
      });

      expect(screen.getByTestId('video-error')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Buffering Tests
  // ===========================================================================

  describe('buffering', () => {
    it('should call onBufferProgress when buffer updates', async () => {
      const onBufferProgress = vi.fn();
      render(
        <VideoPlayer
          src="/test-video.mp4"
          onBufferProgress={onBufferProgress}
        />
      );

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.progress(video);
      });

      expect(onBufferProgress).toHaveBeenCalled();
    });

    it('should show buffering indicator when waiting', async () => {
      render(<VideoPlayer src="/test-video.mp4" />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      // First, trigger canPlay to hide initial loading
      await act(async () => {
        fireEvent.canPlay(video);
      });

      // Then trigger waiting
      await act(async () => {
        fireEvent.waiting(video);
      });

      expect(screen.getByTestId('video-buffering')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Video End Tests
  // ===========================================================================

  describe('video end', () => {
    it('should call onEnded when video ends', async () => {
      const onEnded = vi.fn();
      render(<VideoPlayer src="/test-video.mp4" onEnded={onEnded} />);

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.ended(video);
      });

      expect(onEnded).toHaveBeenCalled();
    });

    it('should loop video when loop prop is true', () => {
      render(<VideoPlayer src="/test-video.mp4" loop />);
      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video.loop).toBe(true);
    });
  });

  // ===========================================================================
  // Dimensions Tests
  // ===========================================================================

  describe('dimensions', () => {
    it('should call onDimensionsChange when video dimensions are known', async () => {
      const onDimensionsChange = vi.fn();
      render(
        <VideoPlayer
          src="/test-video.mp4"
          onDimensionsChange={onDimensionsChange}
        />
      );

      const video = screen.getByTestId('video-element') as HTMLVideoElement;

      await act(async () => {
        fireEvent.loadedMetadata(video);
      });

      expect(onDimensionsChange).toHaveBeenCalledWith({
        width: expect.any(Number),
        height: expect.any(Number),
      });
    });

    it('should maintain aspect ratio by default', () => {
      render(<VideoPlayer src="/test-video.mp4" />);
      const container = screen.getByTestId('video-player');
      expect(container).toHaveClass('aspect-video');
    });

    it('should fill container when objectFit is cover', () => {
      render(<VideoPlayer src="/test-video.mp4" objectFit="cover" />);
      const video = screen.getByTestId('video-element') as HTMLVideoElement;
      expect(video).toHaveClass('object-cover');
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have appropriate aria attributes', () => {
      render(<VideoPlayer src="/test-video.mp4" />);
      const video = screen.getByTestId('video-element');
      expect(video).toHaveAttribute('aria-label');
    });

    it('should support keyboard focus', () => {
      render(<VideoPlayer src="/test-video.mp4" />);
      const container = screen.getByTestId('video-player');
      expect(container).toHaveAttribute('tabIndex', '0');
    });
  });
});

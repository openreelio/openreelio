/**
 * FullscreenPreview Component Tests
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FullscreenPreview } from './FullscreenPreview';

// =============================================================================
// Test Setup
// =============================================================================

const defaultProps = {
  src: 'test-video.mp4',
  currentTime: 30,
  duration: 120,
  isPlaying: false,
  volume: 0.8,
  isMuted: false,
  playbackRate: 1,
  isFullscreen: false,
  onPlayPause: vi.fn(),
  onSeek: vi.fn(),
  onVolumeChange: vi.fn(),
  onMuteToggle: vi.fn(),
  onPlaybackRateChange: vi.fn(),
  onFullscreenToggle: vi.fn(),
};

function renderFullscreenPreview(overrides = {}) {
  const props = { ...defaultProps, ...overrides };
  // Reset all mocks
  Object.values(props).forEach((value) => {
    if (typeof value === 'function' && 'mockClear' in value) {
      (value as ReturnType<typeof vi.fn>).mockClear();
    }
  });
  return render(<FullscreenPreview {...props} />);
}

// =============================================================================
// Tests
// =============================================================================

describe('FullscreenPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders the preview container', () => {
      renderFullscreenPreview();
      expect(screen.getByTestId('fullscreen-preview')).toBeInTheDocument();
    });

    it('renders video element with correct source', () => {
      renderFullscreenPreview({ src: 'my-video.mp4' });
      const video = screen.getByTestId('fullscreen-video');
      expect(video).toHaveAttribute('src', 'my-video.mp4');
    });

    it('renders with poster image when provided', () => {
      renderFullscreenPreview({ poster: 'poster.jpg' });
      const video = screen.getByTestId('fullscreen-video');
      expect(video).toHaveAttribute('poster', 'poster.jpg');
    });

    it('renders center play button when paused', () => {
      renderFullscreenPreview({ isPlaying: false });
      expect(screen.getByTestId('center-play-button')).toBeInTheDocument();
    });

    it('hides center play button when playing', () => {
      renderFullscreenPreview({ isPlaying: true });
      expect(screen.queryByTestId('center-play-button')).not.toBeInTheDocument();
    });

    it('applies fullscreen class when in fullscreen mode', () => {
      renderFullscreenPreview({ isFullscreen: true });
      const container = screen.getByTestId('fullscreen-preview');
      expect(container.className).toContain('fixed');
      expect(container.className).toContain('inset-0');
      expect(container.className).toContain('z-50');
    });
  });

  describe('Time Display', () => {
    it('displays current time and duration', () => {
      renderFullscreenPreview({ currentTime: 65, duration: 300 });
      expect(screen.getByText('1:05 / 5:00')).toBeInTheDocument();
    });

    it('formats hours correctly for long videos', () => {
      renderFullscreenPreview({ currentTime: 3665, duration: 7200 });
      expect(screen.getByText('1:01:05 / 2:00:00')).toBeInTheDocument();
    });

    it('shows 0:00 for zero time', () => {
      renderFullscreenPreview({ currentTime: 0, duration: 60 });
      expect(screen.getByText('0:00 / 1:00')).toBeInTheDocument();
    });
  });

  describe('Play/Pause Controls', () => {
    it('calls onPlayPause when play button clicked', () => {
      const onPlayPause = vi.fn();
      renderFullscreenPreview({ onPlayPause });

      fireEvent.click(screen.getByTestId('play-pause-button'));
      expect(onPlayPause).toHaveBeenCalledTimes(1);
    });

    it('calls onPlayPause when center play button clicked', () => {
      const onPlayPause = vi.fn();
      renderFullscreenPreview({ onPlayPause, isPlaying: false });

      fireEvent.click(screen.getByTestId('center-play-button'));
      expect(onPlayPause).toHaveBeenCalledTimes(1);
    });

    it('shows pause icon when playing', () => {
      renderFullscreenPreview({ isPlaying: true });
      const button = screen.getByTestId('play-pause-button');
      expect(button).toHaveAttribute('title', 'Pause (Space)');
    });

    it('shows play icon when paused', () => {
      renderFullscreenPreview({ isPlaying: false });
      const button = screen.getByTestId('play-pause-button');
      expect(button).toHaveAttribute('title', 'Play (Space)');
    });
  });

  describe('Skip Controls', () => {
    it('seeks back 10 seconds when skip back clicked', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 30 });

      fireEvent.click(screen.getByTestId('skip-back-button'));
      expect(onSeek).toHaveBeenCalledWith(20);
    });

    it('seeks forward 10 seconds when skip forward clicked', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 30, duration: 120 });

      fireEvent.click(screen.getByTestId('skip-forward-button'));
      expect(onSeek).toHaveBeenCalledWith(40);
    });

    it('clamps skip back to 0', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 5 });

      fireEvent.click(screen.getByTestId('skip-back-button'));
      expect(onSeek).toHaveBeenCalledWith(0);
    });

    it('clamps skip forward to duration', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 115, duration: 120 });

      fireEvent.click(screen.getByTestId('skip-forward-button'));
      expect(onSeek).toHaveBeenCalledWith(120);
    });
  });

  describe('Volume Controls', () => {
    it('calls onMuteToggle when mute button clicked', () => {
      const onMuteToggle = vi.fn();
      renderFullscreenPreview({ onMuteToggle });

      fireEvent.click(screen.getByTestId('mute-button'));
      expect(onMuteToggle).toHaveBeenCalledTimes(1);
    });

    it('shows mute icon when muted', () => {
      renderFullscreenPreview({ isMuted: true });
      const button = screen.getByTestId('mute-button');
      expect(button).toHaveAttribute('title', 'Unmute (M)');
    });

    it('shows volume icon when not muted', () => {
      renderFullscreenPreview({ isMuted: false, volume: 0.5 });
      const button = screen.getByTestId('mute-button');
      expect(button).toHaveAttribute('title', 'Mute (M)');
    });

    it('calls onVolumeChange when volume slider changes', () => {
      const onVolumeChange = vi.fn();
      renderFullscreenPreview({ onVolumeChange });

      const slider = screen.getByTestId('volume-slider');
      fireEvent.change(slider, { target: { value: '0.5' } });
      expect(onVolumeChange).toHaveBeenCalledWith(0.5);
    });

    it('shows 0 volume when muted', () => {
      renderFullscreenPreview({ isMuted: true, volume: 0.8 });
      const slider = screen.getByTestId('volume-slider');
      expect(slider).toHaveValue('0');
    });
  });

  describe('Seek Bar', () => {
    it('reflects current time in seek bar', () => {
      renderFullscreenPreview({ currentTime: 60, duration: 120 });
      const seekBar = screen.getByTestId('fullscreen-seek-bar');
      expect(seekBar).toHaveValue('60');
    });

    it('calls onSeek when seek bar changes', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, duration: 120 });

      const seekBar = screen.getByTestId('fullscreen-seek-bar');
      fireEvent.change(seekBar, { target: { value: '45' } });
      expect(onSeek).toHaveBeenCalledWith(45);
    });

    it('has correct min and max attributes', () => {
      renderFullscreenPreview({ duration: 180 });
      const seekBar = screen.getByTestId('fullscreen-seek-bar');
      expect(seekBar).toHaveAttribute('min', '0');
      expect(seekBar).toHaveAttribute('max', '180');
    });
  });

  describe('Playback Speed', () => {
    it('displays current playback rate', () => {
      renderFullscreenPreview({ playbackRate: 1.5 });
      expect(screen.getByTestId('speed-button')).toHaveTextContent('1.5x');
    });

    it('opens speed menu when button clicked', () => {
      renderFullscreenPreview();

      fireEvent.click(screen.getByTestId('speed-button'));
      expect(screen.getByTestId('speed-menu')).toBeInTheDocument();
    });

    it('shows all speed options in menu', () => {
      renderFullscreenPreview();

      fireEvent.click(screen.getByTestId('speed-button'));
      const menu = screen.getByTestId('speed-menu');
      expect(menu).toHaveTextContent('0.25x');
      expect(menu).toHaveTextContent('0.5x');
      expect(menu).toHaveTextContent('1x');
      expect(menu).toHaveTextContent('2x');
    });

    it('calls onPlaybackRateChange when speed selected', () => {
      const onPlaybackRateChange = vi.fn();
      renderFullscreenPreview({ onPlaybackRateChange });

      fireEvent.click(screen.getByTestId('speed-button'));
      const speedButtons = screen.getByTestId('speed-menu').querySelectorAll('button');
      fireEvent.click(speedButtons[6]); // 2x speed (index 6)
      expect(onPlaybackRateChange).toHaveBeenCalledWith(2);
    });
  });

  describe('Fullscreen Controls', () => {
    it('calls onFullscreenToggle when fullscreen button clicked', () => {
      const onFullscreenToggle = vi.fn();
      renderFullscreenPreview({ onFullscreenToggle });

      fireEvent.click(screen.getByTestId('fullscreen-toggle-button'));
      expect(onFullscreenToggle).toHaveBeenCalledTimes(1);
    });

    it('shows minimize icon when in fullscreen', () => {
      renderFullscreenPreview({ isFullscreen: true });
      const button = screen.getByTestId('fullscreen-toggle-button');
      expect(button).toHaveAttribute('title', 'Exit fullscreen (F)');
    });

    it('shows maximize icon when not in fullscreen', () => {
      renderFullscreenPreview({ isFullscreen: false });
      const button = screen.getByTestId('fullscreen-toggle-button');
      expect(button).toHaveAttribute('title', 'Fullscreen (F)');
    });

    it('shows close button in fullscreen mode with exit handler', () => {
      const onExitFullscreen = vi.fn();
      renderFullscreenPreview({ isFullscreen: true, onExitFullscreen });
      expect(screen.getByTestId('close-fullscreen-button')).toBeInTheDocument();
    });

    it('hides close button when not in fullscreen', () => {
      renderFullscreenPreview({ isFullscreen: false });
      expect(screen.queryByTestId('close-fullscreen-button')).not.toBeInTheDocument();
    });

    it('calls onExitFullscreen when close button clicked', () => {
      const onExitFullscreen = vi.fn();
      renderFullscreenPreview({ isFullscreen: true, onExitFullscreen });

      fireEvent.click(screen.getByTestId('close-fullscreen-button'));
      expect(onExitFullscreen).toHaveBeenCalledTimes(1);
    });
  });

  describe('Picture-in-Picture', () => {
    it('shows PiP button when supported', () => {
      const onPipToggle = vi.fn();
      renderFullscreenPreview({ pipSupported: true, onPipToggle });
      expect(screen.getByTestId('pip-button')).toBeInTheDocument();
    });

    it('hides PiP button when not supported', () => {
      renderFullscreenPreview({ pipSupported: false });
      expect(screen.queryByTestId('pip-button')).not.toBeInTheDocument();
    });

    it('calls onPipToggle when PiP button clicked', () => {
      const onPipToggle = vi.fn();
      renderFullscreenPreview({ pipSupported: true, onPipToggle });

      fireEvent.click(screen.getByTestId('pip-button'));
      expect(onPipToggle).toHaveBeenCalledTimes(1);
    });
  });

  describe('Keyboard Shortcuts', () => {
    it('space key toggles play/pause', () => {
      const onPlayPause = vi.fn();
      renderFullscreenPreview({ onPlayPause });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: ' ' });
      expect(onPlayPause).toHaveBeenCalledTimes(1);
    });

    it('k key toggles play/pause', () => {
      const onPlayPause = vi.fn();
      renderFullscreenPreview({ onPlayPause });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'k' });
      expect(onPlayPause).toHaveBeenCalledTimes(1);
    });

    it('left arrow seeks back 5 seconds', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 30 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'ArrowLeft' });
      expect(onSeek).toHaveBeenCalledWith(25);
    });

    it('right arrow seeks forward 5 seconds', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 30, duration: 120 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'ArrowRight' });
      expect(onSeek).toHaveBeenCalledWith(35);
    });

    it('up arrow increases volume', () => {
      const onVolumeChange = vi.fn();
      renderFullscreenPreview({ onVolumeChange, volume: 0.5 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'ArrowUp' });
      expect(onVolumeChange).toHaveBeenCalledWith(0.6);
    });

    it('down arrow decreases volume', () => {
      const onVolumeChange = vi.fn();
      renderFullscreenPreview({ onVolumeChange, volume: 0.5 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'ArrowDown' });
      expect(onVolumeChange).toHaveBeenCalledWith(0.4);
    });

    it('m key toggles mute', () => {
      const onMuteToggle = vi.fn();
      renderFullscreenPreview({ onMuteToggle });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'm' });
      expect(onMuteToggle).toHaveBeenCalledTimes(1);
    });

    it('f key toggles fullscreen', () => {
      const onFullscreenToggle = vi.fn();
      renderFullscreenPreview({ onFullscreenToggle });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'f' });
      expect(onFullscreenToggle).toHaveBeenCalledTimes(1);
    });

    it('escape key exits fullscreen', () => {
      const onExitFullscreen = vi.fn();
      renderFullscreenPreview({ isFullscreen: true, onExitFullscreen });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'Escape' });
      expect(onExitFullscreen).toHaveBeenCalledTimes(1);
    });

    it('escape does nothing when not in fullscreen', () => {
      const onExitFullscreen = vi.fn();
      const onFullscreenToggle = vi.fn();
      renderFullscreenPreview({ isFullscreen: false, onExitFullscreen, onFullscreenToggle });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'Escape' });
      expect(onExitFullscreen).not.toHaveBeenCalled();
      expect(onFullscreenToggle).not.toHaveBeenCalled();
    });

    it('p key toggles PiP when supported', () => {
      const onPipToggle = vi.fn();
      renderFullscreenPreview({ pipSupported: true, onPipToggle });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'p' });
      expect(onPipToggle).toHaveBeenCalledTimes(1);
    });

    it('p key does nothing when PiP not supported', () => {
      const onPipToggle = vi.fn();
      renderFullscreenPreview({ pipSupported: false, onPipToggle });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'p' });
      expect(onPipToggle).not.toHaveBeenCalled();
    });

    it('[ key decreases playback speed', () => {
      const onPlaybackRateChange = vi.fn();
      renderFullscreenPreview({ onPlaybackRateChange, playbackRate: 1 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: '[' });
      expect(onPlaybackRateChange).toHaveBeenCalledWith(0.75);
    });

    it('] key increases playback speed', () => {
      const onPlaybackRateChange = vi.fn();
      renderFullscreenPreview({ onPlaybackRateChange, playbackRate: 1 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: ']' });
      expect(onPlaybackRateChange).toHaveBeenCalledWith(1.25);
    });

    it('comma key steps back one frame', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 1 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: ',' });
      // Frame step is 1/30 second
      expect(onSeek).toHaveBeenCalledWith(expect.closeTo(1 - 1 / 30, 5));
    });

    it('period key steps forward one frame', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 1, duration: 120 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: '.' });
      // Frame step is 1/30 second
      expect(onSeek).toHaveBeenCalledWith(expect.closeTo(1 + 1 / 30, 5));
    });

    it('0 key seeks to beginning', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 60 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: '0' });
      expect(onSeek).toHaveBeenCalledWith(0);
    });

    it('Home key seeks to beginning', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 60 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'Home' });
      expect(onSeek).toHaveBeenCalledWith(0);
    });

    it('End key seeks to end', () => {
      const onSeek = vi.fn();
      renderFullscreenPreview({ onSeek, currentTime: 60, duration: 120 });

      const container = screen.getByTestId('fullscreen-preview');
      fireEvent.keyDown(container, { key: 'End' });
      expect(onSeek).toHaveBeenCalledWith(120);
    });
  });

  describe('Accessibility', () => {
    it('container is focusable', () => {
      renderFullscreenPreview();
      const container = screen.getByTestId('fullscreen-preview');
      expect(container).toHaveAttribute('tabIndex', '0');
    });

    it('has appropriate ARIA attributes', () => {
      renderFullscreenPreview();
      const container = screen.getByTestId('fullscreen-preview');
      expect(container).toHaveAttribute('role', 'application');
      expect(container).toHaveAttribute('aria-label', 'Fullscreen video preview');
    });

    it('includes screen reader keyboard hints', () => {
      renderFullscreenPreview();
      expect(screen.getByText(/Keyboard shortcuts/)).toBeInTheDocument();
    });
  });
});

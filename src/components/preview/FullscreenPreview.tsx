/**
 * FullscreenPreview Component
 *
 * Provides an enhanced fullscreen preview experience with:
 * - Keyboard shortcuts (space, arrows, escape)
 * - Auto-hiding controls
 * - Playback speed control
 * - Timeline scrubber
 * - Picture-in-Picture support
 */

import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import {
  Play,
  Pause,
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX,
  SkipBack,
  SkipForward,
  PictureInPicture,
  Settings,
  X,
} from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface FullscreenPreviewProps {
  /** Video source URL */
  src: string;
  /** Video poster image */
  poster?: string;
  /** Current time in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
  /** Whether video is playing */
  isPlaying: boolean;
  /** Volume level (0-1) */
  volume: number;
  /** Whether video is muted */
  isMuted: boolean;
  /** Playback speed */
  playbackRate: number;
  /** Whether in fullscreen mode */
  isFullscreen: boolean;
  /** Play/pause callback */
  onPlayPause: () => void;
  /** Seek callback */
  onSeek: (time: number) => void;
  /** Volume change callback */
  onVolumeChange: (volume: number) => void;
  /** Mute toggle callback */
  onMuteToggle: () => void;
  /** Playback rate change callback */
  onPlaybackRateChange: (rate: number) => void;
  /** Fullscreen toggle callback */
  onFullscreenToggle: () => void;
  /** Exit fullscreen callback (for close button) */
  onExitFullscreen?: () => void;
  /** Picture-in-Picture toggle callback */
  onPipToggle?: () => void;
  /** Whether PiP is supported */
  pipSupported?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Time in ms to hide controls after no activity */
const CONTROLS_HIDE_DELAY = 3000;

/** Frame step in seconds */
const FRAME_STEP = 1 / 30;

/** Available playback speeds */
const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format time as MM:SS or HH:MM:SS
 */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// =============================================================================
// Component
// =============================================================================

export function FullscreenPreview({
  src,
  poster,
  currentTime,
  duration,
  isPlaying,
  volume,
  isMuted,
  playbackRate,
  isFullscreen,
  onPlayPause,
  onSeek,
  onVolumeChange,
  onMuteToggle,
  onPlaybackRateChange,
  onFullscreenToggle,
  onExitFullscreen,
  onPipToggle,
  pipSupported = false,
}: FullscreenPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // videoRef kept for future PiP implementation and direct video element access
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local state
  const [showControls, setShowControls] = useState(true);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isDraggingSeek, setIsDraggingSeek] = useState(false);

  // ===========================================================================
  // Controls Visibility
  // ===========================================================================

  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);

    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }

    if (isPlaying && !isDraggingSeek) {
      hideTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, CONTROLS_HIDE_DELAY);
    }
  }, [isPlaying, isDraggingSeek]);

  const handleMouseMove = useCallback(() => {
    showControlsTemporarily();
  }, [showControlsTemporarily]);

  // ===========================================================================
  // Keyboard Shortcuts
  // ===========================================================================

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          onPlayPause();
          showControlsTemporarily();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          onSeek(Math.max(0, currentTime - 5));
          showControlsTemporarily();
          break;
        case 'ArrowRight':
          e.preventDefault();
          onSeek(Math.min(duration, currentTime + 5));
          showControlsTemporarily();
          break;
        case 'ArrowUp':
          e.preventDefault();
          onVolumeChange(Math.min(1, volume + 0.1));
          showControlsTemporarily();
          break;
        case 'ArrowDown':
          e.preventDefault();
          onVolumeChange(Math.max(0, volume - 0.1));
          showControlsTemporarily();
          break;
        case ',':
          e.preventDefault();
          onSeek(Math.max(0, currentTime - FRAME_STEP));
          showControlsTemporarily();
          break;
        case '.':
          e.preventDefault();
          onSeek(Math.min(duration, currentTime + FRAME_STEP));
          showControlsTemporarily();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          onMuteToggle();
          showControlsTemporarily();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          onFullscreenToggle();
          break;
        case 'Escape':
          e.preventDefault();
          if (isFullscreen) {
            if (onExitFullscreen) {
              onExitFullscreen();
            } else {
              onFullscreenToggle();
            }
          }
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          if (pipSupported) {
            onPipToggle?.();
          }
          break;
        case '[':
          e.preventDefault();
          {
            const idx = PLAYBACK_SPEEDS.indexOf(playbackRate);
            if (idx > 0) {
              onPlaybackRateChange(PLAYBACK_SPEEDS[idx - 1]);
            }
          }
          showControlsTemporarily();
          break;
        case ']':
          e.preventDefault();
          {
            const idx = PLAYBACK_SPEEDS.indexOf(playbackRate);
            if (idx < PLAYBACK_SPEEDS.length - 1) {
              onPlaybackRateChange(PLAYBACK_SPEEDS[idx + 1]);
            }
          }
          showControlsTemporarily();
          break;
        case '0':
        case 'Home':
          e.preventDefault();
          onSeek(0);
          showControlsTemporarily();
          break;
        case 'End':
          e.preventDefault();
          onSeek(duration);
          showControlsTemporarily();
          break;
      }
    },
    [
      currentTime,
      duration,
      volume,
      playbackRate,
      isFullscreen,
      pipSupported,
      onPlayPause,
      onSeek,
      onVolumeChange,
      onMuteToggle,
      onFullscreenToggle,
      onExitFullscreen,
      onPipToggle,
      onPlaybackRateChange,
      showControlsTemporarily,
    ]
  );

  // ===========================================================================
  // Seek Bar Handling
  // ===========================================================================

  const handleSeekStart = useCallback(() => {
    setIsDraggingSeek(true);
  }, []);

  const handleSeekEnd = useCallback(() => {
    setIsDraggingSeek(false);
  }, []);

  const handleSeekChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const time = parseFloat(e.target.value);
      onSeek(time);
    },
    [onSeek]
  );

  // ===========================================================================
  // Speed Menu
  // ===========================================================================

  const handleSpeedClick = useCallback((speed: number) => {
    onPlaybackRateChange(speed);
    setShowSpeedMenu(false);
  }, [onPlaybackRateChange]);

  // ===========================================================================
  // Effects
  // ===========================================================================

  // Handle play state changes - show controls when play state changes
  useEffect(() => {
    showControlsTemporarily();
  }, [isPlaying, showControlsTemporarily]);

  // Cleanup timeout on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, []);

  // Close speed menu on outside click
  useEffect(() => {
    const handleClick = () => setShowSpeedMenu(false);
    if (showSpeedMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [showSpeedMenu]);

  // ===========================================================================
  // Render
  // ===========================================================================

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      data-testid="fullscreen-preview"
      className={`
        relative w-full h-full bg-black
        ${isFullscreen ? 'fixed inset-0 z-50' : ''}
      `}
      onMouseMove={handleMouseMove}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="application"
      aria-label="Fullscreen video preview"
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        data-testid="fullscreen-video"
        className="absolute inset-0 w-full h-full object-contain"
        src={src}
        poster={poster}
      />

      {/* Center Play Button (shown when paused) */}
      {!isPlaying && (
        <button
          data-testid="center-play-button"
          className="absolute inset-0 flex items-center justify-center cursor-pointer"
          onClick={onPlayPause}
        >
          <div className="w-20 h-20 rounded-full bg-white/20 backdrop-blur flex items-center justify-center hover:bg-white/30 transition-colors">
            <Play className="w-10 h-10 text-white ml-1" />
          </div>
        </button>
      )}

      {/* Controls Overlay */}
      <div
        data-testid="controls-overlay"
        className={`
          absolute inset-0 flex flex-col justify-end
          transition-opacity duration-300
          ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}
        `}
      >
        {/* Top bar with close button */}
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/50 to-transparent">
          {isFullscreen && onExitFullscreen && (
            <button
              data-testid="close-fullscreen-button"
              className="p-2 rounded-full hover:bg-white/20 transition-colors"
              onClick={onExitFullscreen}
              title="Exit fullscreen (Esc)"
            >
              <X className="w-6 h-6 text-white" />
            </button>
          )}
        </div>

        {/* Bottom controls bar */}
        <div className="p-4 bg-gradient-to-t from-black/70 to-transparent">
          {/* Progress bar */}
          <div className="mb-3">
            <input
              data-testid="fullscreen-seek-bar"
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={currentTime}
              onChange={handleSeekChange}
              onMouseDown={handleSeekStart}
              onMouseUp={handleSeekEnd}
              onTouchStart={handleSeekStart}
              onTouchEnd={handleSeekEnd}
              className="w-full h-1 bg-white/30 rounded-full appearance-none cursor-pointer
                [&::-webkit-slider-thumb]:appearance-none
                [&::-webkit-slider-thumb]:w-3
                [&::-webkit-slider-thumb]:h-3
                [&::-webkit-slider-thumb]:bg-white
                [&::-webkit-slider-thumb]:rounded-full
                [&::-webkit-slider-thumb]:cursor-pointer"
              style={{
                background: `linear-gradient(to right, #fff ${progress}%, rgba(255,255,255,0.3) ${progress}%)`,
              }}
            />
          </div>

          {/* Control buttons */}
          <div className="flex items-center justify-between">
            {/* Left controls */}
            <div className="flex items-center gap-3">
              {/* Play/Pause */}
              <button
                data-testid="play-pause-button"
                className="p-2 rounded-full hover:bg-white/20 transition-colors"
                onClick={onPlayPause}
                title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
              >
                {isPlaying ? (
                  <Pause className="w-6 h-6 text-white" />
                ) : (
                  <Play className="w-6 h-6 text-white" />
                )}
              </button>

              {/* Skip back */}
              <button
                data-testid="skip-back-button"
                className="p-2 rounded-full hover:bg-white/20 transition-colors"
                onClick={() => onSeek(Math.max(0, currentTime - 10))}
                title="Back 10s"
              >
                <SkipBack className="w-5 h-5 text-white" />
              </button>

              {/* Skip forward */}
              <button
                data-testid="skip-forward-button"
                className="p-2 rounded-full hover:bg-white/20 transition-colors"
                onClick={() => onSeek(Math.min(duration, currentTime + 10))}
                title="Forward 10s"
              >
                <SkipForward className="w-5 h-5 text-white" />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2 group">
                <button
                  data-testid="mute-button"
                  className="p-2 rounded-full hover:bg-white/20 transition-colors"
                  onClick={onMuteToggle}
                  title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-5 h-5 text-white" />
                  ) : (
                    <Volume2 className="w-5 h-5 text-white" />
                  )}
                </button>
                <input
                  data-testid="volume-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                  className="w-0 group-hover:w-20 h-1 bg-white/30 rounded-full appearance-none transition-all duration-200
                    [&::-webkit-slider-thumb]:appearance-none
                    [&::-webkit-slider-thumb]:w-3
                    [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:bg-white
                    [&::-webkit-slider-thumb]:rounded-full"
                />
              </div>

              {/* Time display */}
              <span className="text-sm text-white font-mono">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-2">
              {/* Speed selector */}
              <div className="relative">
                <button
                  data-testid="speed-button"
                  className="px-2 py-1 rounded hover:bg-white/20 transition-colors text-sm text-white"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSpeedMenu(!showSpeedMenu);
                  }}
                  title="Playback speed"
                >
                  {playbackRate}x
                </button>

                {showSpeedMenu && (
                  <div
                    data-testid="speed-menu"
                    className="absolute bottom-full right-0 mb-2 py-2 bg-black/90 rounded-lg shadow-lg"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {PLAYBACK_SPEEDS.map((speed) => (
                      <button
                        key={speed}
                        className={`
                          block w-full px-4 py-1 text-sm text-left hover:bg-white/20
                          ${speed === playbackRate ? 'text-primary-400' : 'text-white'}
                        `}
                        onClick={() => handleSpeedClick(speed)}
                      >
                        {speed}x
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* PiP button */}
              {pipSupported && onPipToggle && (
                <button
                  data-testid="pip-button"
                  className="p-2 rounded-full hover:bg-white/20 transition-colors"
                  onClick={onPipToggle}
                  title="Picture-in-Picture (P)"
                >
                  <PictureInPicture className="w-5 h-5 text-white" />
                </button>
              )}

              {/* Settings button (placeholder) */}
              <button
                data-testid="settings-button"
                className="p-2 rounded-full hover:bg-white/20 transition-colors"
                title="Settings"
              >
                <Settings className="w-5 h-5 text-white" />
              </button>

              {/* Fullscreen toggle */}
              <button
                data-testid="fullscreen-toggle-button"
                className="p-2 rounded-full hover:bg-white/20 transition-colors"
                onClick={onFullscreenToggle}
                title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
              >
                {isFullscreen ? (
                  <Minimize2 className="w-5 h-5 text-white" />
                ) : (
                  <Maximize2 className="w-5 h-5 text-white" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Keyboard hints overlay (shown briefly on focus) */}
      <div className="sr-only">
        Keyboard shortcuts: Space to play/pause, Arrow keys to seek and adjust volume,
        F for fullscreen, M to mute, comma and period for frame stepping
      </div>
    </div>
  );
}

export default FullscreenPreview;

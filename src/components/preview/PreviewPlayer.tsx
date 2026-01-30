/**
 * PreviewPlayer Container Component
 *
 * Main preview player that integrates VideoPlayer and PlayerControls
 * with state management and keyboard shortcuts.
 */

import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { VideoPlayer } from './VideoPlayer';
import { PlayerControls } from './PlayerControls';
import type { Size2D } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface PreviewPlayerProps {
  /** Video source URL */
  src?: string;
  /** Poster image URL */
  poster?: string;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show controls */
  showControls?: boolean;
  /** External playhead control (seconds) */
  playhead?: number;
  /** Whether player is playing (controlled) */
  isPlaying?: boolean;
  /** Playhead change callback */
  onPlayheadChange?: (time: number) => void;
  /** Play state change callback */
  onPlayStateChange?: (isPlaying: boolean) => void;
  /** Duration change callback */
  onDurationChange?: (duration: number) => void;
  /** Video dimensions change callback */
  onDimensionsChange?: (dimensions: Size2D) => void;
  /** Video ended callback */
  onEnded?: () => void;
}

// =============================================================================
// Component
// =============================================================================

export function PreviewPlayer({
  src,
  poster,
  className = '',
  showControls = true,
  playhead,
  isPlaying: externalIsPlaying,
  onPlayheadChange,
  onPlayStateChange,
  onDurationChange,
  onDimensionsChange,
  onEnded,
}: PreviewPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Internal state
  const [internalPlayhead, setInternalPlayhead] = useState(0);
  const [internalIsPlaying, setInternalIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);

  // Use external values if provided, otherwise use internal
  const currentTime = playhead !== undefined ? playhead : internalPlayhead;
  const isPlaying = externalIsPlaying !== undefined ? externalIsPlaying : internalIsPlaying;

  // ===========================================================================
  // Video Event Handlers
  // ===========================================================================

  const handleTimeUpdate = useCallback(
    (time: number) => {
      setInternalPlayhead(time);
      onPlayheadChange?.(time);
    },
    [onPlayheadChange]
  );

  const handlePlayStateChange = useCallback(
    (playing: boolean) => {
      setInternalIsPlaying(playing);
      onPlayStateChange?.(playing);
    },
    [onPlayStateChange]
  );

  const handleDurationChange = useCallback(
    (dur: number) => {
      setDuration(dur);
      onDurationChange?.(dur);
    },
    [onDurationChange]
  );

  const handleBufferProgress = useCallback((bufferedRanges: TimeRanges | null) => {
    if (bufferedRanges && bufferedRanges.length > 0) {
      // Get the end of the last buffered range
      const lastBuffered = bufferedRanges.end(bufferedRanges.length - 1);
      setBuffered(lastBuffered);
    }
  }, []);

  // ===========================================================================
  // Control Handlers
  // ===========================================================================

  const handlePlayPause = useCallback(() => {
    const video = containerRef.current?.querySelector('video');
    if (video) {
      if (video.paused) {
        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.catch(() => {
            // Autoplay prevented
          });
        }
      } else {
        video.pause();
      }
    }
  }, []);

  const handleSeek = useCallback((time: number) => {
    const video = containerRef.current?.querySelector('video');
    if (video) {
      video.currentTime = time;
      setInternalPlayhead(time);
    }
  }, []);

  const handleVolumeChange = useCallback((newVolume: number) => {
    const video = containerRef.current?.querySelector('video');
    if (video) {
      video.volume = newVolume;
      setVolume(newVolume);
      if (newVolume > 0 && isMuted) {
        video.muted = false;
        setIsMuted(false);
      }
    }
  }, [isMuted]);

  const handleMuteToggle = useCallback(() => {
    const video = containerRef.current?.querySelector('video');
    if (video) {
      video.muted = !video.muted;
      setIsMuted(video.muted);
    }
  }, []);

  const handleFullscreenToggle = useCallback(() => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.().then(() => {
        setIsFullscreen(true);
      }).catch(() => {
        // Fullscreen not supported
      });
    } else {
      document.exitFullscreen?.().then(() => {
        setIsFullscreen(false);
      }).catch(() => {
        // Exit fullscreen failed
      });
    }
  }, []);

  // ===========================================================================
  // Keyboard Shortcuts
  // ===========================================================================

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case ' ':
          e.preventDefault();
          handlePlayPause();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          handleFullscreenToggle();
          break;
      }
    },
    [handlePlayPause, handleFullscreenToggle]
  );

  // ===========================================================================
  // Effects
  // ===========================================================================

  // Sync with external playhead
  useEffect(() => {
    if (playhead !== undefined) {
      const video = containerRef.current?.querySelector('video');
      if (video && Math.abs(video.currentTime - playhead) > 0.1) {
        video.currentTime = playhead;
      }
    }
  }, [playhead]);

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // ===========================================================================
  // Render Empty State
  // ===========================================================================

  if (!src) {
    return (
      <div
        data-testid="preview-player-empty"
        className={`flex items-center justify-center bg-black aspect-video ${className}`}
        role="region"
        aria-label="Video preview"
      >
        <div className="text-gray-500 text-center">
          <svg
            className="w-16 h-16 mx-auto mb-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p>No video selected</p>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      ref={containerRef}
      data-testid="preview-player"
      className={`relative bg-black aspect-video overflow-hidden ${className}`}
      tabIndex={0}
      role="region"
      aria-label="Video preview"
      onKeyDown={handleKeyDown}
    >
      {/* Video */}
      <VideoPlayer
        src={src}
        poster={poster}
        currentTime={playhead}
        playbackRate={playbackRate}
        onTimeUpdate={handleTimeUpdate}
        onPlayStateChange={handlePlayStateChange}
        onDurationChange={handleDurationChange}
        onDimensionsChange={onDimensionsChange}
        onBufferProgress={handleBufferProgress}
        onEnded={onEnded}
        volume={volume}
        muted={isMuted}
      />

      {/* Controls Overlay */}
      {showControls && (
        <div className="absolute bottom-0 left-0 right-0">
          <PlayerControls
            currentTime={currentTime}
            duration={duration}
            isPlaying={isPlaying}
            volume={volume}
            isMuted={isMuted}
            buffered={buffered}
            isFullscreen={isFullscreen}
            playbackRate={playbackRate}
            onPlayPause={handlePlayPause}
            onSeek={handleSeek}
            onVolumeChange={handleVolumeChange}
            onMuteToggle={handleMuteToggle}
            onFullscreenToggle={handleFullscreenToggle}
            onPlaybackRateChange={setPlaybackRate}
          />
        </div>
      )}
    </div>
  );
}

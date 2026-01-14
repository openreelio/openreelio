/**
 * VideoPlayer Component
 *
 * Core video player component that handles video playback with full control support.
 */

import { useRef, useEffect, useState, useCallback, type SyntheticEvent } from 'react';
import type { Size2D } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface VideoPlayerProps {
  /** Video source URL */
  src: string;
  /** Poster image URL */
  poster?: string;
  /** Additional CSS classes */
  className?: string;
  /** Whether to autoplay */
  autoPlay?: boolean;
  /** Whether to loop */
  loop?: boolean;
  /** Whether video is muted */
  muted?: boolean;
  /** Volume (0-1) */
  volume?: number;
  /** Playback rate */
  playbackRate?: number;
  /** Current time in seconds (controlled) */
  currentTime?: number;
  /** Object fit mode */
  objectFit?: 'contain' | 'cover' | 'fill';
  /** Play state change callback */
  onPlayStateChange?: (isPlaying: boolean) => void;
  /** Time update callback */
  onTimeUpdate?: (currentTime: number) => void;
  /** Duration change callback */
  onDurationChange?: (duration: number) => void;
  /** Dimensions change callback */
  onDimensionsChange?: (dimensions: Size2D) => void;
  /** Buffer progress callback */
  onBufferProgress?: (buffered: TimeRanges | null) => void;
  /** Error callback */
  onError?: (error: Event) => void;
  /** Ended callback */
  onEnded?: () => void;
}

type LoadingState = 'loading' | 'ready' | 'error';

// =============================================================================
// Component
// =============================================================================

export function VideoPlayer({
  src,
  poster,
  className = '',
  autoPlay = false,
  loop = false,
  muted = false,
  volume = 1,
  playbackRate = 1,
  currentTime,
  objectFit = 'contain',
  onPlayStateChange,
  onTimeUpdate,
  onDurationChange,
  onDimensionsChange,
  onBufferProgress,
  onError,
  onEnded,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [isBuffering, setIsBuffering] = useState(false);
  const seekingRef = useRef(false);
  const seekedHandlerRef = useRef<(() => void) | null>(null);

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  const handleCanPlay = useCallback(() => {
    setLoadingState('ready');
    setIsBuffering(false);

    if (autoPlay && videoRef.current) {
      const playPromise = videoRef.current.play();
      // Handle browsers that return a promise vs those that don't
      if (playPromise !== undefined) {
        playPromise.catch(() => {
          // Autoplay was prevented, ignore
        });
      }
    }
  }, [autoPlay]);

  const handlePlay = useCallback(() => {
    onPlayStateChange?.(true);
  }, [onPlayStateChange]);

  const handlePause = useCallback(() => {
    onPlayStateChange?.(false);
  }, [onPlayStateChange]);

  const handleTimeUpdate = useCallback(() => {
    if (videoRef.current && !seekingRef.current) {
      onTimeUpdate?.(videoRef.current.currentTime);
    }
  }, [onTimeUpdate]);

  const handleLoadedMetadata = useCallback(() => {
    if (videoRef.current) {
      onDurationChange?.(videoRef.current.duration);
      onDimensionsChange?.({
        width: videoRef.current.videoWidth,
        height: videoRef.current.videoHeight,
      });
    }
  }, [onDurationChange, onDimensionsChange]);

  const handleProgress = useCallback(() => {
    if (videoRef.current) {
      onBufferProgress?.(videoRef.current.buffered);
    }
  }, [onBufferProgress]);

  const handleError = useCallback(
    (e: SyntheticEvent<HTMLVideoElement>) => {
      setLoadingState('error');
      onError?.(e.nativeEvent);
    },
    [onError]
  );

  const handleEnded = useCallback(() => {
    onEnded?.();
  }, [onEnded]);

  const handleWaiting = useCallback(() => {
    setIsBuffering(true);
  }, []);

  const handlePlaying = useCallback(() => {
    setIsBuffering(false);
  }, []);

  // ===========================================================================
  // Sync Props to Video Element
  // ===========================================================================

  // Sync volume
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = Math.max(0, Math.min(1, volume));
    }
  }, [volume]);

  // Sync muted
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muted;
    }
  }, [muted]);

  // Sync playback rate
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  // Sync currentTime (controlled)
  useEffect(() => {
    if (videoRef.current && currentTime !== undefined) {
      const video = videoRef.current;
      const diff = Math.abs(video.currentTime - currentTime);
      // Only seek if difference is significant (> 0.1 seconds)
      if (diff > 0.1) {
        // Clean up previous handler if exists
        if (seekedHandlerRef.current) {
          video.removeEventListener('seeked', seekedHandlerRef.current);
        }

        seekingRef.current = true;
        video.currentTime = currentTime;

        // Reset seeking flag after seek completes
        const handleSeeked = () => {
          seekingRef.current = false;
          video.removeEventListener('seeked', handleSeeked);
          seekedHandlerRef.current = null;
        };
        seekedHandlerRef.current = handleSeeked;
        video.addEventListener('seeked', handleSeeked);
      }
    }
  }, [currentTime]);

  // Cleanup seeked handler on unmount
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video && seekedHandlerRef.current) {
        video.removeEventListener('seeked', seekedHandlerRef.current);
      }
    };
  }, []);

  // Reset loading state when src changes
  useEffect(() => {
    setLoadingState('loading');
    setIsBuffering(false);
  }, [src]);

  // ===========================================================================
  // Object Fit Class
  // ===========================================================================

  const objectFitClass = {
    contain: 'object-contain',
    cover: 'object-cover',
    fill: 'object-fill',
  }[objectFit];

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="video-player"
      className={`relative bg-black aspect-video overflow-hidden ${className}`}
      tabIndex={0}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        data-testid="video-element"
        src={src}
        poster={poster}
        loop={loop}
        muted={muted}
        playsInline
        className={`w-full h-full ${objectFitClass}`}
        aria-label="Video player"
        onCanPlay={handleCanPlay}
        onPlay={handlePlay}
        onPause={handlePause}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onProgress={handleProgress}
        onError={handleError}
        onEnded={handleEnded}
        onWaiting={handleWaiting}
        onPlaying={handlePlaying}
      />

      {/* Loading Indicator */}
      {loadingState === 'loading' && (
        <div
          data-testid="video-loading"
          className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50"
        >
          <div className="flex flex-col items-center gap-2">
            <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <span className="text-white text-sm">Loading...</span>
          </div>
        </div>
      )}

      {/* Buffering Indicator */}
      {isBuffering && loadingState === 'ready' && (
        <div
          data-testid="video-buffering"
          className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-30"
        >
          <div className="w-10 h-10 border-3 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Error State */}
      {loadingState === 'error' && (
        <div
          data-testid="video-error"
          className="absolute inset-0 flex items-center justify-center bg-black"
        >
          <div className="flex flex-col items-center gap-2 text-red-500">
            <svg
              className="w-12 h-12"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <span className="text-sm">Failed to load video</span>
          </div>
        </div>
      )}
    </div>
  );
}

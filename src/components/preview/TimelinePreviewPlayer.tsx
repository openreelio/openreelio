/**
 * TimelinePreviewPlayer Component
 *
 * Canvas-based timeline preview player that renders composite frames
 * from multiple clips at the current playback position.
 *
 * Features:
 * - RAF-based playback loop via usePlaybackLoop
 * - Frame extraction via useAssetFrameExtractor
 * - Seek bar with drag support
 * - Keyboard shortcuts (space for play/pause)
 * - FPS statistics display
 */

import { useRef, useEffect, useCallback, useState, useMemo, memo, type KeyboardEvent } from 'react';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePlaybackLoop } from '@/hooks/usePlaybackLoop';
import { useAssetFrameExtractor } from '@/hooks/useFrameExtractor';
import type { Clip, Track, Sequence } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface TimelinePreviewPlayerProps {
  /** Additional CSS classes */
  className?: string;
  /** Whether to show playback controls */
  showControls?: boolean;
  /** Whether to show timecode display */
  showTimecode?: boolean;
  /** Whether to show FPS statistics */
  showStats?: boolean;
  /** Aspect ratio (width / height) */
  aspectRatio?: number;
  /** Canvas width */
  width?: number;
  /** Canvas height */
  height?: number;
  /** Callback when playback ends */
  onEnded?: () => void;
  /** Callback when frame is rendered */
  onFrameRender?: (time: number) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_ASPECT_RATIO = 16 / 9;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 360;

// =============================================================================
// Component
// =============================================================================

export const TimelinePreviewPlayer = memo(function TimelinePreviewPlayer({
  className = '',
  showControls = false,
  showTimecode = false,
  showStats = false,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  onEnded,
  onFrameRender,
}: TimelinePreviewPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isFrameLoading, setIsFrameLoading] = useState(false);
  const [frameError, setFrameError] = useState<Error | null>(null);

  // Store state
  const {
    isPlaying,
    currentTime,
    duration,
    play,
    pause,
    setCurrentTime,
  } = usePlaybackStore();

  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const sequences = useProjectStore((state) => state.sequences);
  const assets = useProjectStore((state) => state.assets);

  const activeSequence: Sequence | undefined = useMemo(() => {
    return activeSequenceId ? sequences.get(activeSequenceId) : undefined;
  }, [activeSequenceId, sequences]);

  const tracks: Track[] = useMemo(() => {
    return activeSequence?.tracks ?? [];
  }, [activeSequence]);

  // Find the topmost video clip at current time
  const getClipAtTime = useCallback(
    (time: number): { clip: Clip; sourceTime: number } | null => {
      // Determine render order: later tracks are treated as "on top".
      // (The backend model doesn't include a track index yet.)
      const videoTracks = tracks.filter(
        (t: Track) => t.kind === 'video' && t.visible && !t.muted
      );

      for (let ti = videoTracks.length - 1; ti >= 0; ti -= 1) {
        const track = videoTracks[ti];
        for (const clip of track.clips) {
          const clipStart = clip.place.timelineInSec;
          const clipEnd = clipStart + clip.place.durationSec;

          if (time >= clipStart && time < clipEnd) {
            // Calculate source time within the clip, respecting playback speed.
            // timeline delta -> source delta = delta * speed
            const deltaTimeline = time - clipStart;
            const sourceTimeUnclamped = clip.range.sourceInSec + deltaTimeline * clip.speed;
            const sourceTime = Math.min(sourceTimeUnclamped, clip.range.sourceOutSec);
            return { clip, sourceTime };
          }
        }
      }

      return null;
    },
    [tracks]
  );

  // Get active clip info for frame extraction
  const clipInfo = getClipAtTime(currentTime);
  const activeAsset = clipInfo ? assets.get(clipInfo.clip.assetId) : null;

  // Frame extractor for the active asset
  const {
    extractFrame,
    prefetchFrames,
    isLoading: extractorLoading,
    error: extractorError,
  } = useAssetFrameExtractor({
    assetId: activeAsset?.id || '',
    assetPath: activeAsset?.uri || '',
    enabled: !!activeAsset,
  });

  // Sync frame loading state
  useEffect(() => {
    setIsFrameLoading(extractorLoading);
  }, [extractorLoading]);

  // Sync frame error state
  useEffect(() => {
    setFrameError(extractorError);
  }, [extractorError]);

  // ===========================================================================
  // Frame Rendering
  // ===========================================================================

  const renderFrame = useCallback(
    async (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const info = getClipAtTime(time);

      if (!info) {
        // No clip at this time - render black
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }

      try {
        const frameUrl = await extractFrame(info.sourceTime);
        if (frameUrl) {
          // Load and render the image
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            // Clear canvas
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Calculate scaling to fit
            const scale = Math.min(
              canvas.width / img.width,
              canvas.height / img.height
            );
            const x = (canvas.width - img.width * scale) / 2;
            const y = (canvas.height - img.height * scale) / 2;

            ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
          };
          img.onerror = () => {
            // Failed to load image - render black
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          };
          img.src = frameUrl;
        }
      } catch {
        // Error extracting frame - render black
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      onFrameRender?.(time);
    },
    [getClipAtTime, extractFrame, onFrameRender]
  );

  // Playback loop integration
  const handleFrame = useCallback(
    (time: number) => {
      void renderFrame(time);
    },
    [renderFrame]
  );

  const handleEnded = useCallback(() => {
    onEnded?.();
  }, [onEnded]);

  const { isActive, frameCount, actualFps, droppedFrames } = usePlaybackLoop({
    onFrame: handleFrame,
    duration,
    onEnded: handleEnded,
  });

  // Render frame when currentTime changes (for scrubbing)
  useEffect(() => {
    if (!isPlaying) {
      void renderFrame(currentTime);
    }
  }, [currentTime, isPlaying, renderFrame]);

  // Prefetch frames ahead during playback
  useEffect(() => {
    if (isPlaying && activeAsset) {
      const prefetchStart = currentTime;
      const prefetchEnd = Math.min(currentTime + 2, duration);
      prefetchFrames(prefetchStart, prefetchEnd);
    }
  }, [isPlaying, currentTime, duration, activeAsset, prefetchFrames]);

  // ===========================================================================
  // Playback Controls
  // ===========================================================================

  const togglePlayPause = useCallback(() => {
    if (isPlaying) {
      pause();
    } else {
      play();
    }
  }, [isPlaying, play, pause]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault();
        togglePlayPause();
      }
    },
    [togglePlayPause]
  );

  // ===========================================================================
  // Seeking
  // ===========================================================================

  const calculateSeekTime = useCallback(
    (clientX: number): number => {
      const seekBar = seekBarRef.current;
      if (!seekBar) return currentTime;

      const rect = seekBar.getBoundingClientRect();
      const x = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      return ratio * duration;
    },
    [currentTime, duration]
  );

  const handleSeekBarClick = useCallback(
    (e: React.MouseEvent) => {
      const time = calculateSeekTime(e.clientX);
      setCurrentTime(time);
    },
    [calculateSeekTime, setCurrentTime]
  );

  const handleSeekBarMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsDragging(true);
      const time = calculateSeekTime(e.clientX);
      setCurrentTime(time);
    },
    [calculateSeekTime, setCurrentTime]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const time = calculateSeekTime(e.clientX);
      setCurrentTime(time);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, calculateSeekTime, setCurrentTime]);

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  useEffect(() => {
    return () => {
      // Stop playback on unmount
      pause();
    };
  }, [pause]);

  // ===========================================================================
  // Render Empty State
  // ===========================================================================

  if (!activeSequenceId) {
    return (
      <div
        data-testid="timeline-preview-player"
        className={`relative flex items-center justify-center bg-black ${className}`}
        style={{ aspectRatio }}
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
              d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"
            />
          </svg>
          <p>No sequence loaded</p>
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
      data-testid="timeline-preview-player"
      className={`relative bg-black overflow-hidden ${className}`}
      style={{ aspectRatio }}
      tabIndex={0}
      role="region"
      aria-label="Timeline preview"
      onKeyDown={handleKeyDown}
    >
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        data-testid="preview-canvas"
        width={width}
        height={height}
        className="absolute inset-0 w-full h-full object-contain"
      />

      {/* Loading Indicator */}
      {isFrameLoading && (
        <div
          data-testid="preview-loading"
          className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50"
        >
          <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Error State */}
      {frameError && !isFrameLoading && (
        <div
          data-testid="preview-error"
          className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50"
        >
          <div className="text-red-400 text-center">
            <svg
              className="w-8 h-8 mx-auto mb-1"
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
            <span className="text-sm">Error loading frame</span>
          </div>
        </div>
      )}

      {/* Controls */}
      {showControls && (
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2">
          {/* Seek Bar */}
          <div
            ref={seekBarRef}
            data-testid="preview-seek-bar"
            className="h-1 bg-gray-700 rounded cursor-pointer mb-2"
            onClick={handleSeekBarClick}
            onMouseDown={handleSeekBarMouseDown}
          >
            <div
              className="h-full bg-blue-500 rounded"
              style={{ width: `${(currentTime / duration) * 100}%` }}
            />
          </div>

          {/* Buttons Row */}
          <div className="flex items-center gap-2">
            {/* Play/Pause Button */}
            <button
              type="button"
              className="w-8 h-8 flex items-center justify-center text-white hover:bg-white/20 rounded"
              onClick={togglePlayPause}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Timecode */}
            {showTimecode && (
              <span className="text-white text-xs font-mono">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Stats */}
            {showStats && isActive && (
              <span className="text-white/60 text-xs">
                {actualFps.toFixed(1)} fps
                {droppedFrames > 0 && (
                  <span className="text-yellow-400 ml-1">
                    ({droppedFrames} dropped)
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Timecode Overlay (when no controls) */}
      {!showControls && showTimecode && (
        <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs font-mono px-2 py-1 rounded">
          {formatTime(currentTime)}
        </div>
      )}

      {/* Stats Overlay (when no controls) */}
      {!showControls && showStats && isActive && (
        <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
          {actualFps.toFixed(1)} fps | {frameCount} frames
        </div>
      )}
    </div>
  );
});

// =============================================================================
// Helpers
// =============================================================================

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

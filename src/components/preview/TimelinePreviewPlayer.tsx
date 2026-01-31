/**
 * TimelinePreviewPlayer Component
 *
 * Canvas-based timeline preview player that renders composite frames
 * from multiple clips at the current playback position.
 *
 * Features:
 * - Multi-layer composition (renders ALL active clips)
 * - Transform support (position, scale, rotation, anchor)
 * - Opacity and blend mode support
 * - RAF-based playback loop via usePlaybackLoop
 * - Frame extraction via shared FrameCache
 * - Seek bar with drag support
 * - Keyboard shortcuts (space for play/pause)
 * - FPS statistics display
 */

import { useRef, useEffect, useCallback, useState, useMemo, memo, type KeyboardEvent } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePlaybackLoop } from '@/hooks/usePlaybackLoop';
import { useAssetFrameExtractor } from '@/hooks/useFrameExtractor';
import { videoFrameBuffer } from '@/services/videoFrameBuffer';
import { extractTextDataFromClip, renderTextToCanvas } from '@/utils/textRenderer';
import { SeekBar } from './SeekBar';
import { isTextClip } from '@/types';
import type { Clip, Track, Sequence, Asset, BlendMode } from '@/types';

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

/** Clip info with resolved data for rendering */
interface ActiveClipInfo {
  clip: Clip;
  track: Track;
  trackIndex: number;
  clipIndex: number;
  sourceTime: number;
  asset: Asset | undefined;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_ASPECT_RATIO = 16 / 9;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 360;

/** Map BlendMode to Canvas globalCompositeOperation */
const BLEND_MODE_MAP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  add: 'lighter',
};

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
  const [isMultiFrameLoading, setIsMultiFrameLoading] = useState(false);

  // Ref to track latest render request time (for race condition prevention)
  const lastRenderTimeRef = useRef<number>(0);

  // Ref to track last prefetch time (to avoid thrashing)
  const lastPrefetchTimeRef = useRef<number>(0);

  // Track pending extractions to prevent duplicate requests
  const pendingExtractions = useRef<Map<string, Promise<string | null>>>(new Map());

  // Track component mount state to prevent state updates after unmount
  const isMountedRef = useRef(true);

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

  // Note: Sequence format canvas dimensions are available via activeSequence?.format.canvas
  // Currently transforms are calculated relative to the preview canvas dimensions

  // ===========================================================================
  // Get ALL Active Clips at Time
  // ===========================================================================

  /**
   * Returns all renderable clips (video and overlay) active at the given time,
   * sorted by layer order (lower track index = further back, rendered first).
   */
  const getActiveClipsAtTime = useCallback(
    (time: number): ActiveClipInfo[] => {
      const activeClips: ActiveClipInfo[] = [];

      tracks.forEach((track, trackIndex) => {
        // Skip non-renderable tracks (audio, caption), hidden tracks, and muted tracks
        // Both 'video' and 'overlay' tracks can contain visual content
        const isRenderableTrack = track.kind === 'video' || track.kind === 'overlay';
        if (!isRenderableTrack || !track.visible || track.muted) {
          return;
        }

        // Find all clips on this track that are active at the current time
        // Build clip index map for efficient sorting later
        for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex++) {
          const clip = track.clips[clipIndex];
          const clipStart = clip.place.timelineInSec;
          const clipEnd = clipStart + clip.place.durationSec;

          if (time >= clipStart && time < clipEnd) {
            // Calculate source time within the clip, respecting playback speed
            const deltaTimeline = time - clipStart;
            const sourceTimeUnclamped = clip.range.sourceInSec + deltaTimeline * clip.speed;
            // Clamp source time to valid range [sourceInSec, sourceOutSec]
            // This prevents both underflow (before clip start) and overflow (past clip end)
            const sourceTime = Math.max(
              clip.range.sourceInSec,
              Math.min(sourceTimeUnclamped, clip.range.sourceOutSec)
            );

            activeClips.push({
              clip,
              track,
              trackIndex,
              clipIndex,
              sourceTime,
              asset: assets.get(clip.assetId),
            });
          }
        }
      });

      // Sort by track index (lower index = render first = background)
      // Then by clip order within track (later clips render on top)
      activeClips.sort((a, b) => {
        if (a.trackIndex !== b.trackIndex) {
          return a.trackIndex - b.trackIndex;
        }
        return a.clipIndex - b.clipIndex;
      });

      return activeClips;
    },
    [tracks, assets]
  );

  // Get active clip info for the legacy single-asset frame extractor
  // (used for prefetching on the topmost visible clip)
  const getClipAtTime = useCallback(
    (time: number): { clip: Clip; sourceTime: number } | null => {
      const activeClips = getActiveClipsAtTime(time);
      if (activeClips.length === 0) return null;
      // Return the topmost clip (last in sorted array)
      const topClip = activeClips[activeClips.length - 1];
      return { clip: topClip.clip, sourceTime: topClip.sourceTime };
    },
    [getActiveClipsAtTime]
  );

  // Get active clip info for frame extraction (legacy hook compatibility)
  const clipInfo = getClipAtTime(currentTime);
  const activeAsset = clipInfo ? assets.get(clipInfo.clip.assetId) : null;

  // Frame extractor for the topmost active asset (for prefetching)
  // Note: extractFrame is not destructured as we use extractFrameForAsset for multi-layer rendering
  const {
    prefetchFrames,
    isLoading: extractorLoading,
    error: extractorError,
  } = useAssetFrameExtractor({
    assetId: activeAsset?.id || '',
    assetPath: activeAsset?.uri || '',
    enabled: !!activeAsset,
  });

  // Derive frame loading/error state directly from extractor
  // (Removed useEffect syncing - per Vercel best practices, derive state during render)
  const isFrameLoadingDerived = extractorLoading;
  const frameErrorDerived = extractorError;

  // ===========================================================================
  // Frame Extraction (Multi-Asset Support)
  // ===========================================================================

  /**
   * Extract a frame for a specific asset at a given time.
   * Uses the VideoFrameBuffer for optimized dual-frame buffering and smart seeking.
   *
   * Features:
   * - Dual-frame buffer (current + next frame prefetch)
   * - Smart seeking: iterate forward for small jumps
   * - Automatic deduplication of pending requests
   */
  const extractFrameForAsset = useCallback(
    async (assetId: string, assetPath: string, timeSec: number): Promise<string | null> => {
      // Use the advanced VideoFrameBuffer for optimized frame fetching
      // It handles caching, deduplication, and prefetching internally
      try {
        const frameUrl = await videoFrameBuffer.getFrame(assetId, assetPath, timeSec);
        return frameUrl;
      } catch (error) {
        // Log extraction failure with structured data for debugging
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('[TimelinePreviewPlayer] Frame extraction failed:', {
          assetId,
          timeSec: timeSec.toFixed(3),
          error: errorMessage,
        });
        return null;
      }
    },
    []
  );

  // ===========================================================================
  // Frame Rendering (Multi-Layer Composition)
  // ===========================================================================

  // Ref to track loading state without causing re-renders
  const isLoadingRef = useRef(false);

  const renderFrame = useCallback(
    async (time: number) => {
      // Update last render time for race condition prevention
      lastRenderTimeRef.current = time;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        console.error('TimelinePreviewPlayer: Failed to get 2D canvas context');
        return;
      }

      const activeClips = getActiveClipsAtTime(time);

      if (activeClips.length === 0) {
        // No clips at this time - clear canvas and show black
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }

      // Track loading state via ref to avoid re-renders during playback
      // Only update React state when transitioning between loading/not-loading
      const wasLoading = isLoadingRef.current;
      isLoadingRef.current = true;
      if (!wasLoading && isMountedRef.current) {
        setIsMultiFrameLoading(true);
      }

      // Separate text clips from video/image clips
      const textClips: ActiveClipInfo[] = [];
      const mediaClips: ActiveClipInfo[] = [];

      for (const clipInfo of activeClips) {
        if (isTextClip(clipInfo.clip.assetId)) {
          textClips.push(clipInfo);
        } else {
          mediaClips.push(clipInfo);
        }
      }

      // Load all frames in parallel (only for media clips)
      const framePromises = mediaClips.map(async (clipInfo) => {
        if (!clipInfo.asset) return { clipInfo, img: null };

        // For images, use the asset URI directly
        if (clipInfo.asset.kind === 'image') {
          return {
            clipInfo,
            imgUrl: convertFileSrc(clipInfo.asset.uri),
          };
        }

        // For videos, extract the frame
        const frameUrl = await extractFrameForAsset(
          clipInfo.asset.id,
          clipInfo.asset.uri,
          clipInfo.sourceTime
        );

        return { clipInfo, imgUrl: frameUrl };
      });

      const frameResults = await Promise.all(framePromises);

      // Check if this is still the latest request (race condition prevention)
      if (time !== lastRenderTimeRef.current) {
        // Don't clear loading state here - a newer request is in progress
        // and will manage its own loading state
        return;
      }

      // Load all images
      const loadedFrames = await Promise.all(
        frameResults.map(async (result) => {
          // Type guard: check if imgUrl exists and is a string
          const imgUrl = 'imgUrl' in result ? result.imgUrl : null;
          if (!imgUrl || typeof imgUrl !== 'string') {
            return { clipInfo: result.clipInfo, img: null };
          }

          return new Promise<{ clipInfo: ActiveClipInfo; img: HTMLImageElement | null }>(
            (resolve) => {
              const img = new Image();
              img.crossOrigin = 'anonymous';
              img.onload = () => resolve({ clipInfo: result.clipInfo, img });
              img.onerror = () => resolve({ clipInfo: result.clipInfo, img: null });
              img.src = imgUrl;
            }
          );
        })
      );

      // Check again for race condition after async image loading
      if (time !== lastRenderTimeRef.current) {
        // Don't clear loading state here - a newer request is in progress
        // and will manage its own loading state
        return;
      }

      // Clear canvas again before compositing
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Render each clip in layer order (back to front)
      for (const { clipInfo, img } of loadedFrames) {
        if (!img) continue;

        const { clip, track } = clipInfo;
        const transform = clip.transform;

        // Save context state
        ctx.save();

        // Apply opacity
        ctx.globalAlpha = clip.opacity;

        // Apply blend mode
        ctx.globalCompositeOperation = BLEND_MODE_MAP[track.blendMode] || 'source-over';

        // Calculate base scale to fit image in canvas (letterboxing)
        const baseScaleX = canvas.width / img.width;
        const baseScaleY = canvas.height / img.height;
        const baseScale = Math.min(baseScaleX, baseScaleY);

        // Calculate scaled dimensions
        const scaledWidth = img.width * baseScale * transform.scale.x;
        const scaledHeight = img.height * baseScale * transform.scale.y;

        // Calculate center position (normalized coordinates to pixels)
        const centerX = transform.position.x * canvas.width;
        const centerY = transform.position.y * canvas.height;

        // Calculate anchor offset
        const anchorOffsetX = transform.anchor.x * scaledWidth;
        const anchorOffsetY = transform.anchor.y * scaledHeight;

        // Apply transformations
        ctx.translate(centerX, centerY);

        if (transform.rotationDeg !== 0) {
          ctx.rotate((transform.rotationDeg * Math.PI) / 180);
        }

        // Draw image centered on anchor
        ctx.drawImage(
          img,
          -anchorOffsetX,
          -anchorOffsetY,
          scaledWidth,
          scaledHeight
        );

        // Restore context state
        ctx.restore();
      }

      // Render text clips on top of media clips
      for (const clipInfo of textClips) {
        const { clip, track } = clipInfo;
        const textData = extractTextDataFromClip(clip);

        if (!textData) continue;

        // Save context state
        ctx.save();

        // Apply blend mode
        ctx.globalCompositeOperation = BLEND_MODE_MAP[track.blendMode] || 'source-over';

        // Render text with clip opacity
        renderTextToCanvas(ctx, textData, canvas.width, canvas.height, clip.opacity);

        // Restore context state
        ctx.restore();
      }

      // Clear multi-frame loading state (only if mounted and was loading)
      const wasLoadingAtEnd = isLoadingRef.current;
      isLoadingRef.current = false;
      if (wasLoadingAtEnd && isMountedRef.current) {
        setIsMultiFrameLoading(false);
      }

      onFrameRender?.(time);
    },
    [getActiveClipsAtTime, extractFrameForAsset, onFrameRender]
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

  // Prefetch frames ahead during playback (throttled to avoid thrashing)
  useEffect(() => {
    if (isPlaying && activeAsset) {
      // Only prefetch if we've moved significantly (> 1 second) to avoid thrashing
      if (Math.abs(currentTime - lastPrefetchTimeRef.current) > 1) {
        const prefetchStart = currentTime;
        const prefetchEnd = Math.min(currentTime + 2, duration);
        prefetchFrames(prefetchStart, prefetchEnd);
        lastPrefetchTimeRef.current = currentTime;
      }
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

  /**
   * Handle seek from the SeekBar component.
   * Clamps time to valid range and updates store.
   */
  const handleSeek = useCallback(
    (time: number) => {
      const clampedTime = Math.max(0, Math.min(duration, time));
      setCurrentTime(clampedTime);
    },
    [duration, setCurrentTime]
  );

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  useEffect(() => {
    // Mark as mounted
    isMountedRef.current = true;

    // Capture ref value for cleanup (required by react-hooks/exhaustive-deps)
    const extractionsMap = pendingExtractions.current;

    return () => {
      // Mark as unmounted to prevent state updates
      isMountedRef.current = false;
      // Stop playback on unmount
      pause();
      // Clear pending extractions to prevent memory leaks
      // and stale updates after unmount
      extractionsMap.clear();
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
      {(isFrameLoadingDerived || isMultiFrameLoading) && (
        <div
          data-testid="preview-loading"
          className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50"
        >
          <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Error State */}
      {frameErrorDerived && !isFrameLoadingDerived && (
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
          <div className="mb-2">
            <SeekBar
              currentTime={currentTime}
              duration={duration}
              onSeek={handleSeek}
              disabled={!activeSequence}
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

/**
 * Format seconds to MM:SS display format.
 * Handles edge cases like NaN, Infinity, and negative values.
 */
function formatTime(seconds: number): string {
  // Handle invalid inputs
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

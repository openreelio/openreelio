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
import { useSequenceTextClipData } from '@/hooks/useSequenceTextClipData';
import { videoFrameBuffer } from '@/services/videoFrameBuffer';
import { extractTextDataFromClipWithMap, renderTextToCanvas } from '@/utils/textRenderer';
import { getClipSourceTimeAtTimelineTime, isClipActiveAtTime } from '@/utils/clipTiming';
import { isCaptionLikeClip } from '@/utils/captionClip';
import { getEffectiveBlendMode } from '@/utils/blendModes';
import { SeekBar } from './SeekBar';
import { TransformOverlay } from './TransformOverlay';
import { isTextClip } from '@/types';
import type {
  Clip,
  Track,
  Sequence,
  Asset,
  TextClipData,
  Transform,
  BlendMode,
  CaptionPosition,
  CaptionStyle,
} from '@/types';

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

/** Map BlendMode to Canvas globalCompositeOperation.
 * Canvas 2D only supports a subset of blend modes natively.
 * Unsupported modes fall back to 'source-over' (normal). */
const BLEND_MODE_MAP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  add: 'lighter',
  subtract: 'source-over',
  darken: 'darken',
  lighten: 'lighten',
  colorBurn: 'color-burn',
  colorDodge: 'color-dodge',
  linearBurn: 'source-over',
  linearDodge: 'lighter',
  softLight: 'source-over',
  hardLight: 'hard-light',
  vividLight: 'source-over',
  linearLight: 'source-over',
  pinLight: 'source-over',
  difference: 'difference',
  exclusion: 'exclusion',
};

const DEFAULT_CLIP_TRANSFORM: Transform = {
  position: { x: 0.5, y: 0.5 },
  scale: { x: 1.0, y: 1.0 },
  rotationDeg: 0,
  anchor: { x: 0.5, y: 0.5 },
};

function isIdentityTransform(transform: Transform): boolean {
  return (
    Math.abs(transform.position.x - DEFAULT_CLIP_TRANSFORM.position.x) < 0.0001 &&
    Math.abs(transform.position.y - DEFAULT_CLIP_TRANSFORM.position.y) < 0.0001 &&
    Math.abs(transform.scale.x - DEFAULT_CLIP_TRANSFORM.scale.x) < 0.0001 &&
    Math.abs(transform.scale.y - DEFAULT_CLIP_TRANSFORM.scale.y) < 0.0001 &&
    Math.abs(transform.rotationDeg - DEFAULT_CLIP_TRANSFORM.rotationDeg) < 0.0001 &&
    Math.abs(transform.anchor.x - DEFAULT_CLIP_TRANSFORM.anchor.x) < 0.0001 &&
    Math.abs(transform.anchor.y - DEFAULT_CLIP_TRANSFORM.anchor.y) < 0.0001
  );
}

function applyClipTransformToTextData(textData: TextClipData, transform: Transform): TextClipData {
  if (isIdentityTransform(transform)) {
    return textData;
  }

  const scaleFactor = Math.max(
    0.1,
    (Math.abs(transform.scale.x) + Math.abs(transform.scale.y)) / 2,
  );

  return {
    ...textData,
    position: {
      x: transform.position.x,
      y: transform.position.y,
    },
    rotation: transform.rotationDeg,
    style: {
      ...textData.style,
      fontSize: Math.max(1, Math.round(textData.style.fontSize * scaleFactor)),
      backgroundPadding: Math.max(0, Math.round(textData.style.backgroundPadding * scaleFactor)),
      letterSpacing: Math.round(textData.style.letterSpacing * scaleFactor),
    },
    shadow: textData.shadow
      ? {
          ...textData.shadow,
          offsetX: Math.round(textData.shadow.offsetX * scaleFactor),
          offsetY: Math.round(textData.shadow.offsetY * scaleFactor),
          blur: Math.max(0, Math.round(textData.shadow.blur * scaleFactor)),
        }
      : textData.shadow,
    outline: textData.outline
      ? {
          ...textData.outline,
          width: Math.max(1, Math.round(textData.outline.width * scaleFactor)),
        }
      : textData.outline,
  };
}

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
  const [containerSize, setContainerSize] = useState({ width, height });
  const [isMultiFrameLoading, setIsMultiFrameLoading] = useState(false);

  // Ref to track latest render request time (for race condition prevention)
  const lastRenderTimeRef = useRef<number>(0);

  // Ref to track last prefetch time (to avoid thrashing)
  const lastPrefetchTimeRef = useRef<number>(0);

  // Track pending extractions to prevent duplicate requests
  const pendingExtractions = useRef<Map<string, Promise<string | null>>>(new Map());

  // Track component mount state to prevent state updates after unmount
  const isMountedRef = useRef(true);

  // Ref to track last seek render time (for avoiding duplicate renders)
  const lastSeekRenderTimeRef = useRef<number>(-1);

  // Store state
  const { isPlaying, currentTime, duration, syncWithTimeline, play, pause, seek } =
    usePlaybackStore();

  // Ref mirror for syncWithTimeline to safely read the latest value in cleanup
  // without adding syncWithTimeline to the cleanup effect's dependency array.
  const syncWithTimelineRef = useRef(syncWithTimeline);

  const activeSequenceId = useProjectStore((state) => state.activeSequenceId);
  const sequences = useProjectStore((state) => state.sequences);
  const assets = useProjectStore((state) => state.assets);

  const activeSequence: Sequence | undefined = useMemo(() => {
    return activeSequenceId ? sequences.get(activeSequenceId) : undefined;
  }, [activeSequenceId, sequences]);

  const tracks: Track[] = useMemo(() => {
    return activeSequence?.tracks ?? [];
  }, [activeSequence]);

  const textClipDataById = useSequenceTextClipData(activeSequence ?? null);

  // Note: Sequence format canvas dimensions are available via activeSequence?.format.canvas
  // Currently transforms are calculated relative to the preview canvas dimensions

  // ===========================================================================
  // Get ALL Active Clips at Time
  // ===========================================================================

  /**
   * Returns all renderable clips (video/overlay/caption) active at the given time,
   * sorted by layer order (higher track index = further back, rendered first).
   */
  const getActiveClipsAtTime = useCallback(
    (time: number): ActiveClipInfo[] => {
      const activeClips: ActiveClipInfo[] = [];

      tracks.forEach((track, trackIndex) => {
        // Skip non-renderable tracks (audio), hidden tracks, and muted tracks.
        // Video, overlay, and caption tracks can render visuals in canvas mode.
        const isRenderableTrack =
          track.kind === 'video' || track.kind === 'overlay' || track.kind === 'caption';
        if (!isRenderableTrack || !track.visible || track.muted) {
          return;
        }

        // Find all clips on this track that are active at the current time
        // Build clip index map for efficient sorting later
        for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex++) {
          const clip = track.clips[clipIndex];
          if (isClipActiveAtTime(clip, time)) {
            // Calculate source time within the clip, respecting playback speed
            const sourceTime = getClipSourceTimeAtTimelineTime(clip, time);

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

      // Sort back-to-front by track lane order.
      // Timeline renders lower indices as higher lanes, so higher indices should render first.
      activeClips.sort((a, b) => {
        if (a.trackIndex !== b.trackIndex) {
          return b.trackIndex - a.trackIndex;
        }
        return a.clipIndex - b.clipIndex;
      });

      return activeClips;
    },
    [tracks, assets],
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
    [getActiveClipsAtTime],
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
    [],
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

      // Only media clips require frame extraction.
      const mediaClips = activeClips.filter(
        (clipInfo) =>
          !isCaptionLikeClip(clipInfo.track, clipInfo.clip, clipInfo.asset) &&
          !isTextClip(clipInfo.clip.assetId),
      );

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
          clipInfo.sourceTime,
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
            },
          );
        }),
      );

      // Check again for race condition after async image loading
      if (time !== lastRenderTimeRef.current) {
        // Don't clear loading state here - a newer request is in progress
        // and will manage its own loading state
        return;
      }

      const mediaFrameByClipId = new Map<string, HTMLImageElement>();
      for (const { clipInfo, img } of loadedFrames) {
        if (img) {
          mediaFrameByClipId.set(clipInfo.clip.id, img);
        }
      }

      // Clear canvas before compositing
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Render each clip in z-order (back to front) regardless of clip type.
      for (const clipInfo of activeClips) {
        const { clip, track, asset } = clipInfo;
        const blendMode = getEffectiveBlendMode(clip.blendMode, track.blendMode);

        if (isCaptionLikeClip(track, clip, asset)) {
          const text = clip.label?.trim();
          if (!text) {
            continue;
          }

          renderCaptionClipToCanvas(ctx, clip, track.kind, text, canvas.width, canvas.height);
          continue;
        }

        if (isTextClip(clip.assetId)) {
          const textData = extractTextDataFromClipWithMap(clip, textClipDataById);
          if (!textData) {
            continue;
          }

          const transformedTextData = applyClipTransformToTextData(textData, clip.transform);

          ctx.save();
          ctx.globalCompositeOperation = BLEND_MODE_MAP[blendMode] || 'source-over';
          renderTextToCanvas(ctx, transformedTextData, canvas.width, canvas.height, clip.opacity);
          ctx.restore();
          continue;
        }

        const img = mediaFrameByClipId.get(clip.id);
        if (!img) {
          continue;
        }

        const transform = clip.transform;

        ctx.save();
        ctx.globalAlpha = clip.opacity;
        ctx.globalCompositeOperation = BLEND_MODE_MAP[blendMode] || 'source-over';

        const baseScaleX = canvas.width / img.width;
        const baseScaleY = canvas.height / img.height;
        const baseScale = Math.min(baseScaleX, baseScaleY);

        const scaledWidth = img.width * baseScale * transform.scale.x;
        const scaledHeight = img.height * baseScale * transform.scale.y;

        const centerX = transform.position.x * canvas.width;
        const centerY = transform.position.y * canvas.height;

        const anchorOffsetX = transform.anchor.x * scaledWidth;
        const anchorOffsetY = transform.anchor.y * scaledHeight;

        ctx.translate(centerX, centerY);

        if (transform.rotationDeg !== 0) {
          ctx.rotate((transform.rotationDeg * Math.PI) / 180);
        }

        ctx.drawImage(img, -anchorOffsetX, -anchorOffsetY, scaledWidth, scaledHeight);
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
    [getActiveClipsAtTime, extractFrameForAsset, onFrameRender, textClipDataById],
  );

  // Playback loop integration
  const handleFrame = useCallback(
    (time: number) => {
      void renderFrame(time);
    },
    [renderFrame],
  );

  const handleEnded = useCallback(() => {
    onEnded?.();
  }, [onEnded]);

  const { isActive, frameCount, actualFps, droppedFrames } = usePlaybackLoop({
    enabled: !syncWithTimeline,
    onFrame: handleFrame,
    duration,
    onEnded: handleEnded,
  });

  // Render frame when currentTime changes (for scrubbing/seeking)
  useEffect(() => {
    // Always render frame when currentTime changes significantly
    // This handles:
    // 1. Timeline playhead dragging (bidirectional sync)
    // 2. Preview SeekBar scrubbing
    // 3. External seeks from keyboard shortcuts, markers, etc.
    //
    // Skip if this exact time was already rendered to avoid duplicates
    // (usePlaybackLoop handles continuous playback rendering)
    const timeDiff = Math.abs(currentTime - lastSeekRenderTimeRef.current);
    const isSignificantChange = timeDiff > 0.001; // 1ms threshold

    if (isSignificantChange) {
      lastSeekRenderTimeRef.current = currentTime;
      void renderFrame(currentTime);
    }
  }, [currentTime, renderFrame]);

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const updateSize = (): void => {
      const rect = container.getBoundingClientRect();
      setContainerSize((prev) => {
        const nextWidth = rect.width > 0 ? rect.width : prev.width;
        const nextHeight = rect.height > 0 ? rect.height : prev.height;

        if (Math.abs(prev.width - nextWidth) < 0.5 && Math.abs(prev.height - nextHeight) < 0.5) {
          return prev;
        }

        return { width: nextWidth, height: nextHeight };
      });
    };

    updateSize();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(updateSize);
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [width, height]);

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
    [togglePlayPause],
  );

  // ===========================================================================
  // Seeking
  // ===========================================================================

  /**
   * Handle seek from the SeekBar component.
   * Uses seek() instead of setCurrentTime() to ensure proper synchronization
   * with TimelineEngine and trigger seek events.
   */
  const handleSeek = useCallback(
    (time: number) => {
      // seek() already clamps to [0, duration] and dispatches seek event
      seek(time);
    },
    [seek],
  );

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  // Keep the ref mirror in sync with the latest syncWithTimeline value.
  useEffect(() => {
    syncWithTimelineRef.current = syncWithTimeline;
  }, [syncWithTimeline]);

  useEffect(() => {
    // Mark as mounted
    isMountedRef.current = true;

    // Capture ref value for cleanup (required by react-hooks/exhaustive-deps)
    const extractionsMap = pendingExtractions.current;

    return () => {
      // Mark as unmounted to prevent state updates
      isMountedRef.current = false;
      // Stop playback on unmount only when this component owns the playback loop.
      // In timeline-synced mode, playback ownership belongs to TimelineEngine.
      // Use the ref so this cleanup only runs on actual unmount (not when
      // syncWithTimeline changes), preventing unexpected playback interruption.
      if (!syncWithTimelineRef.current) {
        pause();
      }
      // Clear pending extractions to prevent memory leaks
      // and stale updates after unmount
      extractionsMap.clear();
    };
  }, [pause]);

  const overlayDisplayScale = useMemo(() => {
    if (width <= 0 || height <= 0 || containerSize.width <= 0 || containerSize.height <= 0) {
      return 1;
    }

    return Math.min(containerSize.width / width, containerSize.height / height);
  }, [containerSize.width, containerSize.height, width, height]);

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
      className={`relative isolate bg-black overflow-hidden ${className}`}
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

      <TransformOverlay
        sequence={activeSequence ?? null}
        assets={assets}
        canvasWidth={width}
        canvasHeight={height}
        containerWidth={containerSize.width}
        containerHeight={containerSize.height}
        displayScale={overlayDisplayScale}
        panX={0}
        panY={0}
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
                  <span className="text-yellow-400 ml-1">({droppedFrames} dropped)</span>
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

const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Arial',
  fontSize: 48,
  fontWeight: 'normal',
  color: { r: 255, g: 255, b: 255, a: 255 },
  outlineColor: { r: 0, g: 0, b: 0, a: 255 },
  outlineWidth: 2,
  shadowColor: { r: 0, g: 0, b: 0, a: 160 },
  shadowOffset: 2,
  alignment: 'center',
  italic: false,
  underline: false,
};

const DEFAULT_CAPTION_POSITION: CaptionPosition = {
  type: 'preset',
  vertical: 'bottom',
  marginPercent: 5,
};

function clampPercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, value));
}

function normalizeCaptionStyle(style: CaptionStyle | undefined): CaptionStyle {
  if (!style) {
    return DEFAULT_CAPTION_STYLE;
  }

  return {
    ...DEFAULT_CAPTION_STYLE,
    ...style,
    color: {
      ...DEFAULT_CAPTION_STYLE.color,
      ...style.color,
    },
    backgroundColor: style.backgroundColor
      ? {
          r: style.backgroundColor.r,
          g: style.backgroundColor.g,
          b: style.backgroundColor.b,
          a: style.backgroundColor.a,
        }
      : undefined,
    outlineColor: style.outlineColor
      ? {
          r: style.outlineColor.r,
          g: style.outlineColor.g,
          b: style.outlineColor.b,
          a: style.outlineColor.a,
        }
      : undefined,
    shadowColor: style.shadowColor
      ? {
          r: style.shadowColor.r,
          g: style.shadowColor.g,
          b: style.shadowColor.b,
          a: style.shadowColor.a,
        }
      : undefined,
  };
}

function normalizeCaptionPosition(position: CaptionPosition | undefined): CaptionPosition {
  if (!position) {
    return DEFAULT_CAPTION_POSITION;
  }

  if (position.type === 'custom') {
    return {
      type: 'custom',
      xPercent: clampPercent(position.xPercent, 50),
      yPercent: clampPercent(position.yPercent, 90),
    };
  }

  return {
    type: 'preset',
    vertical: position.vertical,
    marginPercent: clampPercent(position.marginPercent, 5),
  };
}

function toRgba(color: { r: number; g: number; b: number; a: number }): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`;
}

function renderCaptionClipToCanvas(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  trackKind: Track['kind'],
  text: string,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const style = normalizeCaptionStyle(clip.captionStyle);
  const position = resolveCaptionPositionForCanvas(clip, trackKind);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return;
  }

  const fontSizePx = Math.max(12, (style.fontSize * canvasHeight) / 1080);
  const fontWeight =
    style.fontWeight === 'bold' ? '700' : style.fontWeight === 'light' ? '300' : '400';
  const fontStyle = style.italic ? 'italic ' : '';
  const lineHeight = fontSizePx * 1.2;

  let xPercent = 50;
  if (style.alignment === 'left') {
    xPercent = 10;
  } else if (style.alignment === 'right') {
    xPercent = 90;
  }

  let yPercent = 90;
  if (position.type === 'custom') {
    xPercent = position.xPercent;
    yPercent = position.yPercent;
  } else if (position.vertical === 'top') {
    yPercent = position.marginPercent;
  } else if (position.vertical === 'center') {
    yPercent = 50;
  } else {
    yPercent = 100 - position.marginPercent;
  }

  const textX = (xPercent / 100) * canvasWidth;
  const textY = (yPercent / 100) * canvasHeight;
  const totalHeight = lineHeight * lines.length;
  const firstLineY = textY - totalHeight / 2 + lineHeight / 2;

  ctx.save();
  ctx.globalAlpha = clip.opacity;
  ctx.font = `${fontStyle}${fontWeight} ${fontSizePx}px ${style.fontFamily}`;
  ctx.textAlign = style.alignment;
  ctx.textBaseline = 'middle';

  if (style.backgroundColor) {
    const padding = fontSizePx * 0.25;
    const maxLineWidth = lines.reduce((maxWidth, line) => {
      return Math.max(maxWidth, ctx.measureText(line).width);
    }, 0);

    let bgX = textX - maxLineWidth / 2 - padding;
    if (style.alignment === 'left') {
      bgX = textX - padding;
    } else if (style.alignment === 'right') {
      bgX = textX - maxLineWidth - padding;
    }

    ctx.fillStyle = toRgba(style.backgroundColor);
    ctx.fillRect(
      bgX,
      firstLineY - lineHeight / 2 - padding,
      maxLineWidth + padding * 2,
      totalHeight + padding * 2,
    );
  }

  if (style.shadowColor && style.shadowOffset > 0) {
    ctx.shadowColor = toRgba(style.shadowColor);
    ctx.shadowOffsetX = style.shadowOffset;
    ctx.shadowOffsetY = style.shadowOffset;
    ctx.shadowBlur = style.shadowOffset;
  }

  if (style.outlineColor && style.outlineWidth > 0) {
    ctx.strokeStyle = toRgba(style.outlineColor);
    ctx.lineWidth = Math.max(1, style.outlineWidth);
    ctx.lineJoin = 'round';
    lines.forEach((line, index) => {
      ctx.strokeText(line, textX, firstLineY + index * lineHeight);
    });
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;
  }

  ctx.fillStyle = toRgba(style.color);
  lines.forEach((line, index) => {
    const lineY = firstLineY + index * lineHeight;
    ctx.fillText(line, textX, lineY);

    if (style.underline) {
      const metrics = ctx.measureText(line);
      let underlineStartX = textX - metrics.width / 2;
      if (style.alignment === 'left') {
        underlineStartX = textX;
      } else if (style.alignment === 'right') {
        underlineStartX = textX - metrics.width;
      }
      const underlineY = lineY + fontSizePx * 0.35;
      ctx.beginPath();
      ctx.moveTo(underlineStartX, underlineY);
      ctx.lineTo(underlineStartX + metrics.width, underlineY);
      ctx.lineWidth = Math.max(1, fontSizePx * 0.06);
      ctx.strokeStyle = toRgba(style.color);
      ctx.stroke();
    }
  });

  ctx.restore();
}

function resolveCaptionPositionForCanvas(clip: Clip, trackKind: Track['kind']): CaptionPosition {
  if (clip.captionPosition) {
    return normalizeCaptionPosition(clip.captionPosition);
  }

  if (trackKind !== 'caption') {
    const xPercent = clampPercent(clip.transform.position.x * 100, 50);
    const yPercent = clampPercent(clip.transform.position.y * 100, 90);
    const hasCustomTransformPosition =
      Math.abs(xPercent - 50) > 0.01 || Math.abs(yPercent - 50) > 0.01;

    if (hasCustomTransformPosition) {
      return {
        type: 'custom',
        xPercent,
        yPercent,
      };
    }
  }

  return DEFAULT_CAPTION_POSITION;
}

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

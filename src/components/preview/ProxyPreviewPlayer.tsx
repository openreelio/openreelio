/**
 * ProxyPreviewPlayer Component
 *
 * Renders timeline sequence preview using proxy videos.
 * Manages multiple video elements for active clips at current time.
 */

import { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  PLAYBACK_EVENTS,
  type PlaybackSeekEventDetail,
  usePlaybackStore,
} from '@/stores/playbackStore';
import { createLogger } from '@/services/logger';
import { PlayerControls } from './PlayerControls';
import { normalizeFileUriToPath } from '@/utils/uri';
import type { Sequence, Asset, Clip } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface ProxyPreviewPlayerProps {
  /** Sequence to preview */
  sequence: Sequence | null;
  /** Assets map for looking up proxy URLs */
  assets: Map<string, Asset>;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show controls */
  showControls?: boolean;
}

interface ActiveClip {
  clip: Clip;
  asset: Asset;
  trackId: string;
  trackIndex: number;
}

interface RenderableClip extends ActiveClip {
  src: string;
}

// =============================================================================
// Constants
// =============================================================================

const FRAME_INTERVAL = 1000 / 30; // 30fps for animation frame updates
const PRECISE_SEEK_TOLERANCE = 0.008; // ~0.5 frame at 60fps for paused scrubbing
const DRIFT_SEEK_TOLERANCE = 0.12; // reduce micro-stutter from overly frequent drift seeks
const HARD_SEEK_DETECTION_DELTA = 0.25; // Treat as explicit jump when delta exceeds this
const TIME_CHANGE_EPSILON = 0.001;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

const logger = createLogger('ProxyPreviewPlayer');

function getSafeClipSpeed(clip: Clip): number {
  return clip.speed > 0 ? clip.speed : 1;
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path);
}

function clampTimelineTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) {
    return 0;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return Math.max(0, time);
  }
  return Math.max(0, Math.min(duration, time));
}

// =============================================================================
// Component
// =============================================================================

export function ProxyPreviewPlayer({
  sequence,
  assets,
  className = '',
  showControls = true,
}: ProxyPreviewPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const animationFrameRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef<number>(0);
  // Track previous store time to detect explicit jump seeks during active playback.
  const prevTimeRef = useRef<number>(0);

  // Playback state from store
  const {
    currentTime,
    isPlaying,
    syncWithTimeline = true,
    duration,
    volume,
    isMuted,
    playbackRate,
    seek,
    setCurrentTime,
    setIsPlaying,
    togglePlayback,
    setVolume,
    toggleMute,
    setPlaybackRate,
  } = usePlaybackStore();

  // Local state
  const [buffered, setBuffered] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoErrors, setVideoErrors] = useState<Map<string, string>>(new Map());

  // NOTE: Playback duration is managed by useTimelineEngine (Timeline component).
  // Do NOT compute or set it here - competing setDuration calls cause the SeekBar
  // and Timeline to use different duration ranges, breaking positional sync.

  // Calculate sequence FPS
  const sequenceFps = useMemo(() => {
    if (!sequence?.format?.fps) return 30;
    const { num, den } = sequence.format.fps;
    return den > 0 ? num / den : 30;
  }, [sequence]);

  // Cache previous active clip result to stabilize the reference when the same
  // clips are active across consecutive frames. This prevents unnecessary
  // downstream re-renders and effect re-fires during steady-state playback.
  const prevActiveClipsRef = useRef<ActiveClip[]>([]);

  // Find active clips at current time (sorted by layer/track)
  const activeClips = useMemo((): ActiveClip[] => {
    if (!sequence) {
      if (prevActiveClipsRef.current.length === 0) return prevActiveClipsRef.current;
      prevActiveClipsRef.current = [];
      return prevActiveClipsRef.current;
    }

    const clips: ActiveClip[] = [];

    sequence.tracks.forEach((track, trackIndex) => {
      if (track.muted || !track.visible) return;

      // Proxy mode renders plain video tracks only (no overlay/caption compositing).
      if (track.kind !== 'video') return;

      for (const clip of track.clips) {
        const clipSpeed = clip.speed > 0 ? clip.speed : 1;
        const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clipSpeed;
        const clipEnd = clip.place.timelineInSec + clipDuration;

        // Check if clip is active at current time
        if (currentTime >= clip.place.timelineInSec && currentTime < clipEnd) {
          const asset = assets.get(clip.assetId);
          if (!asset || asset.kind !== 'video') {
            continue;
          }

          clips.push({
            clip,
            asset,
            trackId: track.id,
            trackIndex,
          });
        }
      }
    });

    // Sort by trackIndex (lower track = rendered first/behind)
    clips.sort((a, b) => a.trackIndex - b.trackIndex);

    // Return the same reference if the active clip set hasn't changed.
    // This avoids cascading re-renders when playhead moves within the same clip.
    const prev = prevActiveClipsRef.current;
    if (
      clips.length === prev.length &&
      clips.every(
        (clipInfo, index) =>
          clipInfo.clip === prev[index].clip &&
          clipInfo.asset === prev[index].asset &&
          clipInfo.trackId === prev[index].trackId &&
          clipInfo.trackIndex === prev[index].trackIndex,
      )
    ) {
      return prev;
    }

    prevActiveClipsRef.current = clips;
    return clips;
  }, [sequence, currentTime, assets]);

  // Get video source URL for an asset
  // Prioritizes proxy URL when proxy is ready, falls back to original.
  // Rejects unsupported URI schemes to prevent unsafe URL injection.
  const getVideoSrc = useCallback((asset: Asset): string | null => {
    const safeDecodeURIComponent = (input: string): string => {
      try {
        return decodeURIComponent(input);
      } catch {
        return input;
      }
    };

    // Use proxy URL only when proxy generation is complete
    const useProxy = asset.proxyStatus === 'ready' && asset.proxyUrl;
    const url = (useProxy ? asset.proxyUrl : asset.uri)?.trim();

    if (!url) return null;

    const hasUnsupportedUriScheme =
      URI_SCHEME_PATTERN.test(url) &&
      !isWindowsAbsolutePath(url) &&
      !url.startsWith('http://') &&
      !url.startsWith('https://') &&
      !url.startsWith('file://') &&
      !url.startsWith('asset://');

    if (hasUnsupportedUriScheme) {
      const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
      logger.warn('Blocked unsupported preview media URL scheme', { assetId: asset.id, scheme });
      return null;
    }

    // Already a valid HTTP/HTTPS URL
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }

    // Already converted to Tauri asset protocol (starts with asset://)
    // Note: This should rarely happen as backend now sends raw paths
    if (url.startsWith('asset://')) {
      // Try to extract the path and re-convert properly
      // Format might be: asset://localhost/C:/path/to/file
      const pathMatch = url.match(/^asset:\/\/localhost\/(.+)$/);
      if (pathMatch) {
        return convertFileSrc(safeDecodeURIComponent(pathMatch[1]));
      }
      return url;
    }

    // Convert file:// URL to Tauri asset protocol
    if (url.startsWith('file://')) {
      const path = normalizeFileUriToPath(url);
      return convertFileSrc(path);
    }

    // Handle all other paths (Windows: C:\\path, Unix: /path)
    // convertFileSrc handles both formats correctly
    return convertFileSrc(safeDecodeURIComponent(url));
  }, []);

  const renderableClips = useMemo((): RenderableClip[] => {
    const clips: RenderableClip[] = [];

    for (const clipInfo of activeClips) {
      const src = getVideoSrc(clipInfo.asset);
      if (!src) continue;
      clips.push({ ...clipInfo, src });
    }

    return clips;
  }, [activeClips, getVideoSrc]);

  const getClampedSourceTime = useCallback((clip: Clip, timelineTime: number) => {
    const offsetInClip = timelineTime - clip.place.timelineInSec;
    const safeSpeed = getSafeClipSpeed(clip);
    const sourceTime = clip.range.sourceInSec + offsetInClip * safeSpeed;
    return Math.max(clip.range.sourceInSec, Math.min(clip.range.sourceOutSec, sourceTime));
  }, []);

  // Sync video elements to timeline position.
  // - forceSeek=true: hard align to requested time (user seek/scrub)
  // - forceSeek=false: only correct significant drift during playback
  const syncVideos = useCallback(
    (timelineTime: number, forceSeek: boolean = false) => {
      const safeTimelineTime = clampTimelineTime(timelineTime, duration);

      renderableClips.forEach(({ clip }) => {
        const video = videoRefs.current.get(clip.id);
        if (!video) return;

        const clampedSourceTime = getClampedSourceTime(clip, safeTimelineTime);
        const safeSpeed = getSafeClipSpeed(clip);

        const tolerance = forceSeek || !isPlaying ? PRECISE_SEEK_TOLERANCE : DRIFT_SEEK_TOLERANCE;
        // During active playback, avoid forcing currentTime while the element is
        // already seeking. Re-seeking a seeking element can cause visible jitter.
        if (!forceSeek && isPlaying && video.seeking) {
          return;
        }

        if (Math.abs(video.currentTime - clampedSourceTime) > tolerance) {
          video.currentTime = clampedSourceTime;
        }

        // Sync playback rate
        video.playbackRate = playbackRate * safeSpeed;

        // ProxyPreviewPlayer video elements stay muted; Web Audio owns timeline audio output.
        // Keep volume at zero as a defensive fallback even if browser muted state changes.
        video.volume = 0;

        // Sync play state
        if (isPlaying && video.paused) {
          const playResult = video.play();
          if (playResult && typeof playResult.catch === 'function') {
            void playResult.catch(() => {
              // Autoplay prevented
            });
          }
        } else if (!isPlaying && !video.paused) {
          video.pause();
        }
      });
    },
    [duration, renderableClips, getClampedSourceTime, isPlaying, playbackRate],
  );

  // Track playback start time for synthetic time advancement
  const playbackStartRef = useRef<{ timestamp: number; timelineTime: number } | null>(null);

  // Animation frame loop for playback
  const updatePlayback = useCallback(
    (timestamp: number) => {
      if (!isPlaying) return;

      // Limit updates to avoid excessive re-renders
      if (timestamp - lastUpdateTimeRef.current >= FRAME_INTERVAL) {
        const prevTimestamp = lastUpdateTimeRef.current;
        lastUpdateTimeRef.current = timestamp;

        // Find the first playing video to sync time from (not just first clip)
        // This handles cases where some clips may have load errors or be paused
        let foundVideoSource = false;
        for (const { clip } of renderableClips) {
          const video = videoRefs.current.get(clip.id);
          if (video && !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            // Calculate timeline time from video time
            const offsetInSource = video.currentTime - clip.range.sourceInSec;
            const safeSpeed = getSafeClipSpeed(clip);
            const timelineTime = clip.place.timelineInSec + offsetInSource / safeSpeed;
            const clampedTimelineTime = clampTimelineTime(timelineTime, duration);
            setCurrentTime(clampedTimelineTime, 'proxy-video-clock');
            // Update synthetic time reference
            playbackStartRef.current = { timestamp, timelineTime: clampedTimelineTime };
            foundVideoSource = true;
            break; // Use first valid video as time source
          }
        }

        // Fallback: If no video is available, advance time synthetically
        // This ensures playback continues even when all videos fail to load
        if (!foundVideoSource && prevTimestamp > 0) {
          const elapsed = (timestamp - prevTimestamp) / 1000; // Convert to seconds
          const timeAdvance = elapsed * playbackRate;
          const newTime = clampTimelineTime(currentTime + timeAdvance, duration);
          setCurrentTime(newTime, 'proxy-synthetic-clock');

          // Stop at end of duration
          if (newTime >= duration) {
            setIsPlaying(false);
          }
        }
      }

      animationFrameRef.current = requestAnimationFrame(updatePlayback);
    },
    [isPlaying, renderableClips, setCurrentTime, playbackRate, currentTime, duration, setIsPlaying],
  );

  // Start/stop animation frame loop
  useEffect(() => {
    // TimelineEngine is the authoritative playback clock in editor mode.
    // Keep this fallback loop disabled while timeline sync is enabled to avoid
    // competing currentTime writers and playhead snap-back during scrubbing.
    if (isPlaying && !syncWithTimeline) {
      animationFrameRef.current = requestAnimationFrame(updatePlayback);
    } else if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isPlaying, syncWithTimeline, updatePlayback]);

  // Baseline sync pass (playing only):
  // Drift correction during active playback. When paused, the hard-seek
  // effect below handles precise alignment on every time change.
  useEffect(() => {
    if (!isPlaying) return;
    syncVideos(currentTime, false);
  }, [currentTime, isPlaying, syncVideos]);

  // Playback state transition sync:
  // Ensure pause is applied immediately even when currentTime does not change.
  // Without this, toggling play->pause can leave HTMLVideoElements running
  // until the next seek/time update arrives.
  useEffect(() => {
    if (!isPlaying) {
      // Hard-stop every known video element to avoid background playback from
      // stale refs that may not be in the current active clip set.
      videoRefs.current.forEach((video) => {
        if (!video.paused) {
          video.pause();
        }
      });

      syncVideos(currentTime, true);
    }
  }, [isPlaying, currentTime, syncVideos]);

  // Hard-seek pass:
  // - always when paused (timeline scrubbing/playhead drag)
  // - when playing only for explicit jump deltas
  useEffect(() => {
    const timeDiff = Math.abs(currentTime - prevTimeRef.current);
    const hasSignificantTimeChange = timeDiff > TIME_CHANGE_EPSILON;

    if (hasSignificantTimeChange) {
      const shouldHardSeek = !isPlaying || timeDiff >= HARD_SEEK_DETECTION_DELTA;
      if (shouldHardSeek) {
        syncVideos(currentTime, true);
      }
    }

    // Always update ref to prevent drift from sub-epsilon increments
    prevTimeRef.current = currentTime;
  }, [currentTime, isPlaying, syncVideos]);

  // Explicit user-intent seek path (seek bar, keyboard jump, etc.).
  // Use hard seek regardless of playback state to keep preview frame-accurate.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handlePlaybackSeek = (event: Event) => {
      const customEvent = event as CustomEvent<PlaybackSeekEventDetail>;
      const targetTime = customEvent.detail?.time;
      if (!Number.isFinite(targetTime)) {
        return;
      }
      syncVideos(targetTime, true);
    };

    window.addEventListener(PLAYBACK_EVENTS.SEEK, handlePlaybackSeek);
    return () => {
      window.removeEventListener(PLAYBACK_EVENTS.SEEK, handlePlaybackSeek);
    };
  }, [syncVideos]);

  // Clean up stale video refs
  useEffect(() => {
    const activeClipIds = new Set(renderableClips.map((c) => c.clip.id));
    videoRefs.current.forEach((video, clipId) => {
      if (!activeClipIds.has(clipId)) {
        video.pause();
        videoRefs.current.delete(clipId);
      }
    });
  }, [renderableClips]);

  // Clear error state when clips change or proxy becomes ready
  useEffect(() => {
    const activeClipIds = new Set(renderableClips.map((c) => c.clip.id));

    setVideoErrors((prev) => {
      let changed = false;
      const next = new Map(prev);

      // Clear errors for clips that are no longer active
      next.forEach((_, clipId) => {
        if (!activeClipIds.has(clipId)) {
          next.delete(clipId);
          changed = true;
        }
      });

      // Clear errors for clips whose proxy is now ready
      renderableClips.forEach(({ clip, asset }) => {
        if (next.has(clip.id) && asset.proxyStatus === 'ready') {
          next.delete(clip.id);
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [renderableClips]);

  // Handle video element ref
  const setVideoRef = useCallback((clipId: string, el: HTMLVideoElement | null) => {
    if (el) {
      videoRefs.current.set(clipId, el);
    } else {
      videoRefs.current.delete(clipId);
    }
  }, []);

  // Handle video loaded
  const handleVideoLoaded = useCallback(
    (clipId: string) => {
      const video = videoRefs.current.get(clipId);
      if (video) {
        // Update buffered progress
        if (video.buffered.length > 0) {
          const bufferedEnd = video.buffered.end(video.buffered.length - 1);
          setBuffered(bufferedEnd);
        }
        // Clear any previous error for this clip (skip if no error existed)
        setVideoErrors((prev) => {
          if (!prev.has(clipId)) return prev;
          const next = new Map(prev);
          next.delete(clipId);
          return next;
        });

        // Keep newly loaded clips frame-accurate with the current playhead.
        // Without this, paused scrubbing can display frame 0 until the next seek.
        syncVideos(currentTime, true);
      }
    },
    [currentTime, syncVideos],
  );

  // Handle video load error
  const handleVideoError = useCallback((clipId: string, error: string) => {
    logger.error('Proxy video element failed to load', { clipId, error });
    setVideoErrors((prev) => {
      const next = new Map(prev);
      next.set(clipId, error);
      return next;
    });
  }, []);

  // Control handlers
  const handlePlayPause = useCallback(() => {
    togglePlayback();
  }, [togglePlayback]);

  const handleSeek = useCallback(
    (time: number) => {
      seek(Math.max(0, Math.min(duration, time)));
    },
    [seek, duration],
  );

  const handleVolumeChange = useCallback(
    (newVolume: number) => {
      setVolume(newVolume);
    },
    [setVolume],
  );

  const handleMuteToggle = useCallback(() => {
    toggleMute();
  }, [toggleMute]);

  const handleFullscreenToggle = useCallback(() => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      void containerRef.current
        .requestFullscreen?.()
        .then(() => {
          setIsFullscreen(true);
        })
        .catch(() => {
          // Fullscreen not supported
        });
    } else {
      void document
        .exitFullscreen?.()
        .then(() => {
          setIsFullscreen(false);
        })
        .catch(() => {
          // Exit failed
        });
    }
  }, []);

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

  // Handle playback end
  useEffect(() => {
    if (!syncWithTimeline && isPlaying && currentTime >= duration && duration > 0) {
      setIsPlaying(false);
      setCurrentTime(duration, 'proxy-playback-end');
    }
  }, [syncWithTimeline, currentTime, duration, isPlaying, setIsPlaying, setCurrentTime]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.defaultPrevented) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlayback();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          handleFullscreenToggle();
          break;
      }
    },
    [togglePlayback, handleFullscreenToggle],
  );

  // Calculate aspect ratio from sequence format (guard against zero height)
  const aspectRatio =
    sequence?.format?.canvas && sequence.format.canvas.height > 0
      ? sequence.format.canvas.width / sequence.format.canvas.height
      : 16 / 9;

  // Empty state
  if (!sequence) {
    return (
      <div
        data-testid="proxy-preview-empty"
        className={`flex items-center justify-center bg-black ${className}`}
        style={{ aspectRatio: 16 / 9 }}
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
          <p>No sequence loaded</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="proxy-preview-player"
      className={`relative bg-black overflow-hidden ${className}`}
      style={{ aspectRatio }}
      tabIndex={0}
      role="region"
      aria-label="Video preview"
      onKeyDown={handleKeyDown}
    >
      {/* Video Layers */}
      <div className="absolute inset-0">
        {renderableClips.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <p>No clips at current time</p>
          </div>
        ) : (
          renderableClips.map(({ clip, asset, trackIndex, src }) => {
            const error = videoErrors.get(clip.id);

            // Show error state if video failed to load
            if (error) {
              return (
                <div
                  key={clip.id}
                  data-testid={`proxy-video-error-${clip.id}`}
                  className="absolute inset-0 flex items-center justify-center bg-gray-900"
                  style={{ zIndex: trackIndex * 10 }}
                >
                  <div className="text-center text-red-400">
                    <svg
                      className="w-12 h-12 mx-auto mb-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                    <p className="text-sm">Failed to load video</p>
                    <p className="text-xs text-gray-500 mt-1">{asset.name}</p>
                  </div>
                </div>
              );
            }

            return (
              <video
                key={clip.id}
                ref={(el) => setVideoRef(clip.id, el)}
                data-testid={`proxy-video-${clip.id}`}
                src={src}
                className="absolute inset-0 w-full h-full object-contain"
                style={{
                  opacity: clip.opacity,
                  zIndex: trackIndex * 10,
                }}
                playsInline
                muted
                onLoadedData={() => handleVideoLoaded(clip.id)}
                onError={(e) =>
                  handleVideoError(clip.id, e.currentTarget.error?.message || 'Unknown error')
                }
              />
            );
          })
        )}
      </div>

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
            fps={sequenceFps}
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

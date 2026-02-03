/**
 * ProxyPreviewPlayer Component
 *
 * Renders timeline sequence preview using proxy videos.
 * Manages multiple video elements for active clips at current time.
 */

import { useRef, useMemo, useCallback, useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { usePlaybackStore } from '@/stores/playbackStore';
import { PlayerControls } from './PlayerControls';
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

// =============================================================================
// Constants
// =============================================================================

const FRAME_INTERVAL = 1000 / 30; // 30fps for animation frame updates
// Reduced seek tolerance for more responsive scrubbing (was 0.05)
// Lower value = more responsive but more seeks
const SEEK_TOLERANCE = 0.016; // ~1 frame at 60fps for immediate response

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
  // Track previous time for external seek detection
  const prevTimeRef = useRef<number>(0);

  // Playback state from store
  const {
    currentTime,
    isPlaying,
    duration,
    volume,
    isMuted,
    playbackRate,
    setCurrentTime,
    setIsPlaying,
    setDuration,
    togglePlayback,
    setVolume,
    toggleMute,
    setPlaybackRate,
  } = usePlaybackStore();

  // Local state
  const [buffered, setBuffered] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoErrors, setVideoErrors] = useState<Map<string, string>>(new Map());

  // Calculate sequence duration
  const sequenceDuration = useMemo(() => {
    if (!sequence) return 0;

    let maxEnd = 0;
    for (const track of sequence.tracks) {
      for (const clip of track.clips) {
        const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
        const clipEnd = clip.place.timelineInSec + clipDuration;
        if (clipEnd > maxEnd) {
          maxEnd = clipEnd;
        }
      }
    }
    return maxEnd;
  }, [sequence]);

  // Calculate sequence FPS
  const sequenceFps = useMemo(() => {
    if (!sequence?.format?.fps) return 30;
    const { num, den } = sequence.format.fps;
    return den > 0 ? num / den : 30;
  }, [sequence]);

  // Update store duration when sequence changes
  useEffect(() => {
    if (sequenceDuration > 0) {
      setDuration(sequenceDuration);
    }
  }, [sequenceDuration, setDuration]);

  // Find active clips at current time (sorted by layer/track)
  const activeClips = useMemo((): ActiveClip[] => {
    if (!sequence) return [];

    const clips: ActiveClip[] = [];

    sequence.tracks.forEach((track, trackIndex) => {
      if (track.muted || !track.visible) return;

      for (const clip of track.clips) {
        const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
        const clipEnd = clip.place.timelineInSec + clipDuration;

        // Check if clip is active at current time
        if (currentTime >= clip.place.timelineInSec && currentTime < clipEnd) {
          const asset = assets.get(clip.assetId);
          if (asset) {
            clips.push({
              clip,
              asset,
              trackId: track.id,
              trackIndex,
            });
          }
        }
      }
    });

    // Sort by trackIndex (lower track = rendered first/behind)
    return clips.sort((a, b) => a.trackIndex - b.trackIndex);
  }, [sequence, currentTime, assets]);

  // Get video source URL for an asset
  // Prioritizes proxy URL when proxy is ready, falls back to original
  const getVideoSrc = useCallback((asset: Asset): string | null => {
    // Use proxy URL only when proxy generation is complete
    const useProxy = asset.proxyStatus === 'ready' && asset.proxyUrl;
    const url = useProxy ? asset.proxyUrl : asset.uri;

    if (!url) return null;

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
        return convertFileSrc(pathMatch[1]);
      }
      return url;
    }

    // Convert file:// URL to Tauri asset protocol
    if (url.startsWith('file://')) {
      const path = url.replace('file://', '');
      return convertFileSrc(path);
    }

    // Handle all other paths (Windows: C:\path, Unix: /path)
    // convertFileSrc handles both formats correctly
    return convertFileSrc(url);
  }, []);

  // Sync video elements to timeline position
  const syncVideos = useCallback(() => {
    activeClips.forEach(({ clip }) => {
      const video = videoRefs.current.get(clip.id);
      if (!video) return;

      // Calculate source time from timeline time
      const offsetInClip = currentTime - clip.place.timelineInSec;
      const sourceTime = clip.range.sourceInSec + (offsetInClip * clip.speed);

      // Only seek if difference is significant (reduced tolerance for responsive scrubbing)
      if (Math.abs(video.currentTime - sourceTime) > SEEK_TOLERANCE) {
        video.currentTime = sourceTime;
      }

      // Sync playback rate
      video.playbackRate = playbackRate * clip.speed;

      // Sync volume - Convert dB to linear scale
      // Note: Use nullish coalescing (??) not truthy check because volumeDb=0 is valid (unity gain)
      const clipVolumeDb = clip.audio?.volumeDb ?? 0;
      const clipLinearVolume = Math.pow(10, clipVolumeDb / 20);
      video.volume = isMuted ? 0 : volume * clipLinearVolume;

      // Sync play state
      if (isPlaying && video.paused) {
        void video.play().catch(() => {
          // Autoplay prevented
        });
      } else if (!isPlaying && !video.paused) {
        video.pause();
      }
    });
  }, [activeClips, currentTime, isPlaying, playbackRate, volume, isMuted]);

  // Track playback start time for synthetic time advancement
  const playbackStartRef = useRef<{ timestamp: number; timelineTime: number } | null>(null);

  // Animation frame loop for playback
  const updatePlayback = useCallback((timestamp: number) => {
    if (!isPlaying) return;

    // Limit updates to avoid excessive re-renders
    if (timestamp - lastUpdateTimeRef.current >= FRAME_INTERVAL) {
      const prevTimestamp = lastUpdateTimeRef.current;
      lastUpdateTimeRef.current = timestamp;

      // Find the first playing video to sync time from (not just first clip)
      // This handles cases where some clips may have load errors or be paused
      let foundVideoSource = false;
      for (const { clip } of activeClips) {
        const video = videoRefs.current.get(clip.id);
        if (video && !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          // Calculate timeline time from video time
          const offsetInSource = video.currentTime - clip.range.sourceInSec;
          const timelineTime = clip.place.timelineInSec + (offsetInSource / clip.speed);
          setCurrentTime(timelineTime);
          // Update synthetic time reference
          playbackStartRef.current = { timestamp, timelineTime };
          foundVideoSource = true;
          break; // Use first valid video as time source
        }
      }

      // Fallback: If no video is available, advance time synthetically
      // This ensures playback continues even when all videos fail to load
      if (!foundVideoSource && prevTimestamp > 0) {
        const elapsed = (timestamp - prevTimestamp) / 1000; // Convert to seconds
        const timeAdvance = elapsed * playbackRate;
        const newTime = Math.min(currentTime + timeAdvance, duration);
        setCurrentTime(newTime);

        // Stop at end of duration
        if (newTime >= duration) {
          setIsPlaying(false);
        }
      }
    }

    animationFrameRef.current = requestAnimationFrame(updatePlayback);
  }, [isPlaying, activeClips, setCurrentTime, playbackRate, currentTime, duration, setIsPlaying]);

  // Start/stop animation frame loop
  useEffect(() => {
    if (isPlaying) {
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
  }, [isPlaying, updatePlayback]);

  // Sync videos when state changes
  useEffect(() => {
    syncVideos();
  }, [syncVideos]);

  // Explicit video seek when currentTime changes externally (timeline scrubbing)
  // This ensures immediate response to timeline playhead dragging
  useEffect(() => {
    // Skip if time hasn't changed significantly (avoids redundant seeks)
    const timeDiff = Math.abs(currentTime - prevTimeRef.current);
    if (timeDiff < 0.001) return; // 1ms threshold
    prevTimeRef.current = currentTime;

    // Force sync all videos to new time position
    activeClips.forEach(({ clip }) => {
      const video = videoRefs.current.get(clip.id);
      if (!video) return;

      // Calculate source time from timeline time
      const offsetInClip = currentTime - clip.place.timelineInSec;
      const sourceTime = clip.range.sourceInSec + (offsetInClip * clip.speed);
      const clampedTime = Math.max(
        clip.range.sourceInSec,
        Math.min(clip.range.sourceOutSec, sourceTime)
      );

      // Always update video time for responsive scrubbing
      if (Math.abs(video.currentTime - clampedTime) > SEEK_TOLERANCE) {
        video.currentTime = clampedTime;
      }
    });
  }, [currentTime, activeClips]);

  // Clean up stale video refs
  useEffect(() => {
    const activeClipIds = new Set(activeClips.map(c => c.clip.id));
    videoRefs.current.forEach((video, clipId) => {
      if (!activeClipIds.has(clipId)) {
        video.pause();
        videoRefs.current.delete(clipId);
      }
    });
  }, [activeClips]);

  // Clear error state when clips change or proxy becomes ready
  useEffect(() => {
    const activeClipIds = new Set(activeClips.map(c => c.clip.id));

    setVideoErrors(prev => {
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
      activeClips.forEach(({ clip, asset }) => {
        if (next.has(clip.id) && asset.proxyStatus === 'ready') {
          next.delete(clip.id);
          changed = true;
        }
      });

      return changed ? next : prev;
    });
  }, [activeClips]);

  // Handle video element ref
  const setVideoRef = useCallback((clipId: string, el: HTMLVideoElement | null) => {
    if (el) {
      videoRefs.current.set(clipId, el);
    } else {
      videoRefs.current.delete(clipId);
    }
  }, []);

  // Handle video loaded
  const handleVideoLoaded = useCallback((clipId: string) => {
    const video = videoRefs.current.get(clipId);
    if (video) {
      // Update buffered progress
      if (video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        setBuffered(bufferedEnd);
      }
      // Clear any previous error for this clip
      setVideoErrors(prev => {
        const next = new Map(prev);
        next.delete(clipId);
        return next;
      });
    }
  }, []);

  // Handle video load error
  const handleVideoError = useCallback((clipId: string, error: string) => {
    setVideoErrors(prev => {
      const next = new Map(prev);
      next.set(clipId, error);
      return next;
    });
  }, []);

  // Control handlers
  const handlePlayPause = useCallback(() => {
    togglePlayback();
  }, [togglePlayback]);

  const handleSeek = useCallback((time: number) => {
    setCurrentTime(Math.max(0, Math.min(duration, time)));
  }, [setCurrentTime, duration]);

  const handleVolumeChange = useCallback((newVolume: number) => {
    setVolume(newVolume);
  }, [setVolume]);

  const handleMuteToggle = useCallback(() => {
    toggleMute();
  }, [toggleMute]);

  const handleFullscreenToggle = useCallback(() => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      void containerRef.current.requestFullscreen?.().then(() => {
        setIsFullscreen(true);
      }).catch(() => {
        // Fullscreen not supported
      });
    } else {
      void document.exitFullscreen?.().then(() => {
        setIsFullscreen(false);
      }).catch(() => {
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
    if (isPlaying && currentTime >= duration && duration > 0) {
      setIsPlaying(false);
      setCurrentTime(duration);
    }
  }, [currentTime, duration, isPlaying, setIsPlaying, setCurrentTime]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
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
  }, [togglePlayback, handleFullscreenToggle]);

  // Calculate aspect ratio from sequence format
  const aspectRatio = sequence?.format?.canvas
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
        {activeClips.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <p>No clips at current time</p>
          </div>
        ) : (
          activeClips.map(({ clip, asset, trackIndex }) => {
            const src = getVideoSrc(asset);
            const error = videoErrors.get(clip.id);

            if (!src) return null;

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
                muted={isMuted || clip.audio?.muted}
                onLoadedData={() => handleVideoLoaded(clip.id)}
                onError={(e) => handleVideoError(clip.id, e.currentTarget.error?.message || 'Unknown error')}
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

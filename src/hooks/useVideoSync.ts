/**
 * useVideoSync Hook
 *
 * Synchronizes multiple video elements to timeline playback position.
 * Handles seeking, playback rate, and play/pause state synchronization.
 */

import { useEffect, useCallback, useRef } from 'react';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Clip, Asset } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface UseVideoSyncOptions {
  /** Map of clip IDs to video elements */
  videoRefs: Map<string, HTMLVideoElement>;
  /** Active clips at current time */
  clips: Clip[];
  /** Assets map for looking up asset data */
  assets: Map<string, Asset>;
  /** Whether sync is enabled */
  enabled?: boolean;
}

export interface UseVideoSyncReturn {
  /** Manually sync all videos to current time */
  syncAll: () => void;
  /** Sync a specific video by clip ID */
  syncVideo: (clipId: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Threshold for seeking (in seconds) */
const SEEK_THRESHOLD = 0.1;

/** Maximum time to wait for video to be ready (ms) */
const READY_TIMEOUT = 5000;

// =============================================================================
// Hook
// =============================================================================

export function useVideoSync({
  videoRefs,
  clips,
  assets,
  enabled = true,
}: UseVideoSyncOptions): UseVideoSyncReturn {
  // Note: 'assets' is available for future enhancements (e.g., loading state, proxy URL lookup)
  void assets;
  const lastSyncTimeRef = useRef<number>(0);
  const syncingRef = useRef<Set<string>>(new Set());

  // Playback state from store
  const { currentTime, isPlaying, playbackRate } = usePlaybackStore();

  /**
   * Calculate the source time for a clip given a timeline time
   */
  const calculateSourceTime = useCallback((clip: Clip, timelineTime: number): number => {
    const offsetInClip = timelineTime - clip.place.timelineInSec;
    return clip.range.sourceInSec + (offsetInClip * clip.speed);
  }, []);

  /**
   * Check if video is ready for playback
   */
  const isVideoReady = useCallback((video: HTMLVideoElement): boolean => {
    return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }, []);

  /**
   * Wait for video to be ready
   */
  const waitForVideoReady = useCallback((video: HTMLVideoElement, clipId: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (isVideoReady(video)) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Video ${clipId} not ready within timeout`));
      }, READY_TIMEOUT);

      const handleCanPlay = () => {
        cleanup();
        resolve();
      };

      const handleError = () => {
        cleanup();
        reject(new Error(`Video ${clipId} error`));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('canplay', handleCanPlay);
        video.removeEventListener('error', handleError);
      };

      video.addEventListener('canplay', handleCanPlay);
      video.addEventListener('error', handleError);
    });
  }, [isVideoReady]);

  /**
   * Sync a single video element to the timeline
   */
  const syncVideo = useCallback((clipId: string) => {
    if (!enabled) return;

    const video = videoRefs.get(clipId);
    if (!video) return;

    const clip = clips.find(c => c.id === clipId);
    if (!clip) return;

    // Prevent recursive syncing
    if (syncingRef.current.has(clipId)) return;
    syncingRef.current.add(clipId);

    try {
      // Calculate target source time
      const targetSourceTime = calculateSourceTime(clip, currentTime);

      // Clamp to valid range
      const clampedTime = Math.max(
        clip.range.sourceInSec,
        Math.min(clip.range.sourceOutSec, targetSourceTime)
      );

      // Seek if difference is significant
      if (Math.abs(video.currentTime - clampedTime) > SEEK_THRESHOLD) {
        video.currentTime = clampedTime;
      }

      // Set playback rate
      video.playbackRate = playbackRate * clip.speed;

      // Sync play state
      if (isPlaying) {
        if (video.paused) {
          video.play().catch(() => {
            // Autoplay prevented or other error
          });
        }
      } else {
        if (!video.paused) {
          video.pause();
        }
      }
    } finally {
      syncingRef.current.delete(clipId);
    }
  }, [enabled, videoRefs, clips, currentTime, isPlaying, playbackRate, calculateSourceTime]);

  /**
   * Sync all video elements
   */
  const syncAll = useCallback(() => {
    if (!enabled) return;

    clips.forEach(clip => {
      syncVideo(clip.id);
    });
  }, [enabled, clips, syncVideo]);

  // Sync videos when currentTime changes (seeking)
  useEffect(() => {
    if (!enabled) return;

    // Debounce syncing during rapid time updates
    const now = performance.now();
    if (now - lastSyncTimeRef.current < 16) return; // ~60fps limit
    lastSyncTimeRef.current = now;

    syncAll();
  }, [enabled, currentTime, syncAll]);

  // Sync videos when play state changes
  useEffect(() => {
    if (!enabled) return;

    syncAll();
  }, [enabled, isPlaying, syncAll]);

  // Sync videos when playback rate changes
  useEffect(() => {
    if (!enabled) return;

    clips.forEach(clip => {
      const video = videoRefs.get(clip.id);
      if (video) {
        video.playbackRate = playbackRate * clip.speed;
      }
    });
  }, [enabled, playbackRate, clips, videoRefs]);

  // Handle new video elements being added
  useEffect(() => {
    if (!enabled) return;

    clips.forEach(clip => {
      const video = videoRefs.get(clip.id);
      if (video && !isVideoReady(video)) {
        // Wait for video to be ready, then sync
        waitForVideoReady(video, clip.id)
          .then(() => syncVideo(clip.id))
          .catch(() => {
            // Video failed to load
          });
      }
    });
  }, [enabled, clips, videoRefs, isVideoReady, waitForVideoReady, syncVideo]);

  return {
    syncAll,
    syncVideo,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculate timeline time from a video's current time
 */
export function calculateTimelineTime(clip: Clip, sourceTime: number): number {
  const offsetInSource = sourceTime - clip.range.sourceInSec;
  return clip.place.timelineInSec + (offsetInSource / clip.speed);
}

/**
 * Check if a timeline time falls within a clip's range
 */
export function isTimeInClip(clip: Clip, timelineTime: number): boolean {
  const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
  const clipEnd = clip.place.timelineInSec + clipDuration;
  return timelineTime >= clip.place.timelineInSec && timelineTime < clipEnd;
}

/**
 * Get the duration of a clip on the timeline
 */
export function getClipTimelineDuration(clip: Clip): number {
  return (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
}

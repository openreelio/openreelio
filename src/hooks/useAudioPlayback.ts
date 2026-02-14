/**
 * useAudioPlayback Hook
 *
 * Manages audio playback using Web Audio API for timeline sequence clips.
 * Handles loading, scheduling, and synchronization of audio clips.
 *
 * Features:
 * - Automatic retry with exponential backoff for failed audio loads
 * - Audio buffer caching to prevent redundant fetches
 * - Clip-level volume and mute controls
 * - Seamless seek handling with source rescheduling
 */

import { useRef, useCallback, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { usePlaybackStore } from '@/stores/playbackStore';
import { playbackController } from '@/services/PlaybackController';
import type { Sequence, Asset, Clip } from '@/types';
import { createLogger } from '@/services/logger';

const logger = createLogger('AudioPlayback');

// =============================================================================
// Types
// =============================================================================

export interface UseAudioPlaybackOptions {
  /** Sequence containing audio clips */
  sequence: Sequence | null;
  /** Assets map for looking up audio sources */
  assets: Map<string, Asset>;
  /** Whether to enable audio playback */
  enabled?: boolean;
}

export interface UseAudioPlaybackReturn {
  /** Initialize audio context (must be called on user interaction) */
  initAudio: () => Promise<void>;
  /** Whether audio context is initialized */
  isAudioReady: boolean;
  /** Retry loading a failed asset */
  retryLoad: (assetId: string) => Promise<boolean>;
  /** Get list of assets that failed to load */
  failedAssets: string[];
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  clipId: string;
  startTime: number;
}

interface FailedLoadInfo {
  assetId: string;
  lastAttempt: number;
  attemptCount: number;
  error: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Base schedule-ahead time in seconds.
 * Extended during rapid seeking to catch more clips.
 */
const BASE_SCHEDULE_AHEAD_TIME = 0.5;

/**
 * Maximum schedule-ahead time during rapid seeking.
 */
const MAX_SCHEDULE_AHEAD_TIME = 2.0;

/**
 * Check for rescheduling every 250ms.
 */
const RESCHEDULE_INTERVAL = 0.25;

/**
 * Seek velocity threshold (seconds per second) for extended scheduling.
 * If seeking faster than this, extend the schedule window.
 */
const RAPID_SEEK_VELOCITY_THRESHOLD = 5.0;

/**
 * Minimum timeline delta to consider as a potential seek/jump.
 */
const SEEK_DETECTION_DELTA_THRESHOLD = 0.1;

/**
 * Base tolerance (seconds) for normal playback progression jitter.
 * Prevents false-positive seek detection during regular playback updates.
 */
const PLAYBACK_PROGRESS_TOLERANCE = 0.08;

/** Maximum retry attempts for failed audio loads */
const MAX_RETRY_ATTEMPTS = 3;

/** Base delay for exponential backoff (ms) */
const RETRY_BASE_DELAY_MS = 1000;

/** Maximum delay between retries (ms) */
const RETRY_MAX_DELAY_MS = 10000;

// =============================================================================
// Hook
// =============================================================================

export function useAudioPlayback({
  sequence,
  assets,
  enabled = true,
}: UseAudioPlaybackOptions): UseAudioPlaybackReturn {
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const scheduledSourcesRef = useRef<Map<string, ScheduledSource>>(new Map());
  const scheduleVersionRef = useRef(0);
  const isSchedulingRef = useRef(false);
  const rescheduleRequestedRef = useRef(false);
  const masterGainRef = useRef<GainNode | null>(null);
  const isAudioReadyRef = useRef(false);
  const lastScheduleTimeRef = useRef(0);

  /**
   * Track failed audio loads for retry mechanism.
   * Key: assetId, Value: failure info with attempt count
   */
  const failedLoadsRef = useRef<Map<string, FailedLoadInfo>>(new Map());

  /**
   * Pending retry timeouts to cancel on unmount.
   */
  const retryTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Playback state from store
  const { currentTime, isPlaying, volume, isMuted, playbackRate } = usePlaybackStore();
  const isPlayingRef = useRef(isPlaying);

  const getLiveIsPlaying = useCallback((): boolean => {
    const storeApi = usePlaybackStore as unknown as {
      getState?: () => { isPlaying?: boolean };
    };
    if (typeof storeApi.getState === 'function') {
      const liveState = storeApi.getState();
      if (liveState && typeof liveState.isPlaying === 'boolean') {
        return liveState.isPlaying;
      }
    }
    return isPlayingRef.current;
  }, []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  /**
   * Initialize AudioContext on user interaction
   */
  const initAudio = useCallback(async () => {
    if (audioContextRef.current) {
      // Resume if suspended
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      isAudioReadyRef.current = true;
      return;
    }

    // Create new AudioContext
    audioContextRef.current = new AudioContext();

    // Create master gain node
    masterGainRef.current = audioContextRef.current.createGain();
    masterGainRef.current.connect(audioContextRef.current.destination);

    // Resume if needed
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    isAudioReadyRef.current = true;
  }, []);

  /**
   * Calculate retry delay with exponential backoff.
   */
  const getRetryDelay = useCallback((attemptCount: number): number => {
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attemptCount - 1);
    return Math.min(delay, RETRY_MAX_DELAY_MS);
  }, []);

  /**
   * Load audio buffer for an asset with automatic retry on failure.
   *
   * Features:
   * - Cached buffer lookup
   * - Exponential backoff retry
   * - Failed load tracking for UI feedback
   */
  const loadAudioBuffer = useCallback(
    async (assetId: string, assetUri: string, isRetry = false): Promise<AudioBuffer | null> => {
      // Check cache first
      const cached = audioBuffersRef.current.get(assetId);
      if (cached) {
        // Clear any failed state if we have a cached buffer
        failedLoadsRef.current.delete(assetId);
        return cached;
      }

      if (!audioContextRef.current) return null;

      // Check if we've exceeded retry attempts
      const failedInfo = failedLoadsRef.current.get(assetId);
      if (failedInfo && failedInfo.attemptCount >= MAX_RETRY_ATTEMPTS && !isRetry) {
        logger.debug('Skipping load - max retry attempts reached', { assetId });
        return null;
      }

      try {
        // Convert to Tauri asset URL
        let url = assetUri;
        if (url.startsWith('file://')) {
          url = convertFileSrc(url.replace('file://', ''));
        } else if (url.startsWith('/') || url.match(/^[A-Za-z]:\\/)) {
          url = convertFileSrc(url);
        }

        logger.debug('Loading audio buffer', { assetId, isRetry });

        // Fetch and decode audio
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);

        // Cache the buffer and clear failed state
        audioBuffersRef.current.set(assetId, audioBuffer);
        failedLoadsRef.current.delete(assetId);

        logger.debug('Audio buffer loaded successfully', { assetId });

        return audioBuffer;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const currentAttempt = (failedInfo?.attemptCount ?? 0) + 1;

        // Track the failure
        failedLoadsRef.current.set(assetId, {
          assetId,
          lastAttempt: Date.now(),
          attemptCount: currentAttempt,
          error: errorMessage,
        });

        logger.error('Failed to load audio for asset', {
          assetId,
          error: errorMessage,
          attempt: currentAttempt,
          maxAttempts: MAX_RETRY_ATTEMPTS,
        });

        // Schedule automatic retry if under the limit
        if (currentAttempt < MAX_RETRY_ATTEMPTS) {
          const retryDelay = getRetryDelay(currentAttempt);
          logger.debug('Scheduling audio load retry', {
            assetId,
            retryDelay,
            attempt: currentAttempt,
          });

          // Clear any existing retry timeout
          const existingTimeout = retryTimeoutsRef.current.get(assetId);
          if (existingTimeout) {
            clearTimeout(existingTimeout);
          }

          // Schedule retry
          const timeoutId = setTimeout(() => {
            retryTimeoutsRef.current.delete(assetId);
            void loadAudioBuffer(assetId, assetUri, true);
          }, retryDelay);

          retryTimeoutsRef.current.set(assetId, timeoutId);
        }

        return null;
      }
    },
    [getRetryDelay],
  );

  /**
   * Manually retry loading a failed asset.
   * Resets the attempt counter and immediately attempts to load.
   */
  const retryLoad = useCallback(
    async (assetId: string): Promise<boolean> => {
      const asset = assets.get(assetId);
      if (!asset) {
        logger.warn('Cannot retry load: asset not found', { assetId });
        return false;
      }

      // Reset failure tracking
      failedLoadsRef.current.delete(assetId);

      // Clear any pending retry
      const existingTimeout = retryTimeoutsRef.current.get(assetId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        retryTimeoutsRef.current.delete(assetId);
      }

      const audioUrl = asset.proxyUrl || asset.uri;
      const buffer = await loadAudioBuffer(assetId, audioUrl, true);

      return buffer !== null;
    },
    [assets, loadAudioBuffer],
  );

  /**
   * Get all audio clips from sequence
   */
  const getAudioClips = useCallback((): Array<{
    clip: Clip;
    asset: Asset;
    trackVolume: number;
    trackMuted: boolean;
  }> => {
    if (!sequence) return [];

    const audioClips: Array<{
      clip: Clip;
      asset: Asset;
      trackVolume: number;
      trackMuted: boolean;
    }> = [];

    for (const track of sequence.tracks) {
      // Include both audio tracks and video tracks with audio
      if (track.muted) continue;

      for (const clip of track.clips) {
        const asset = assets.get(clip.assetId);
        if (!asset) continue;

        // Check if asset has audio
        const hasAudio = asset.kind === 'audio' || (asset.kind === 'video' && asset.audio);
        if (!hasAudio) continue;

        audioClips.push({
          clip,
          asset,
          trackVolume: track.volume,
          trackMuted: track.muted,
        });
      }
    }

    return audioClips;
  }, [sequence, assets]);

  /**
   * Stop all scheduled sources
   */
  const stopAllSources = useCallback(() => {
    // Invalidate any in-flight async scheduling work.
    // This prevents stale `scheduleAudioClips()` calls from creating
    // new sources after pause/seek/cleanup has already stopped playback.
    scheduleVersionRef.current += 1;
    rescheduleRequestedRef.current = false;

    scheduledSourcesRef.current.forEach((scheduled) => {
      try {
        scheduled.source.stop();
        scheduled.source.disconnect();
        scheduled.gainNode.disconnect();
      } catch {
        // Already stopped
      }
    });
    scheduledSourcesRef.current.clear();
  }, []);

  /**
   * Calculate clip volume from various sources
   * Track volume is linear (0.0-2.0), clip volumeDb is in dB
   */
  const calculateClipVolume = useCallback((clip: Clip, trackVolume: number): number => {
    // Apply clip mute first
    if (clip.audio?.muted) return 0;

    // Convert clip dB to linear and multiply with track volume
    const clipVolumeDb = clip.audio?.volumeDb ?? 0;
    const clipLinearVolume = Math.pow(10, clipVolumeDb / 20);

    return trackVolume * clipLinearVolume;
  }, []);

  // Track seek velocity for dynamic scheduling window (ref used across effects)
  const seekVelocityRef = useRef(0);

  /**
   * Calculate dynamic schedule-ahead time based on seek velocity.
   * Extends window during rapid seeking to catch more clips.
   */
  const getScheduleAheadTime = useCallback((): number => {
    const velocity = seekVelocityRef.current;

    // If seeking rapidly, extend the schedule window
    if (velocity > RAPID_SEEK_VELOCITY_THRESHOLD) {
      // Scale window based on velocity, up to max
      const scaleFactor = Math.min(velocity / RAPID_SEEK_VELOCITY_THRESHOLD, 4);
      return Math.min(BASE_SCHEDULE_AHEAD_TIME * scaleFactor, MAX_SCHEDULE_AHEAD_TIME);
    }

    return BASE_SCHEDULE_AHEAD_TIME;
  }, []);

  /**
   * Schedule audio clips for playback.
   * Uses dynamic scheduling window based on seek velocity.
   */
  const scheduleAudioClips = useCallback(async () => {
    if (!audioContextRef.current || !masterGainRef.current || !enabled) return;
    if (!isPlaying || !getLiveIsPlaying()) return;

    // Prevent overlapping async scheduling passes.
    // Overlaps can create duplicate BufferSource nodes for the same clip.
    if (isSchedulingRef.current) {
      rescheduleRequestedRef.current = true;
      return;
    }

    isSchedulingRef.current = true;

    try {
      schedulingPass: do {
        rescheduleRequestedRef.current = false;

        if (!audioContextRef.current || !masterGainRef.current || !enabled || !getLiveIsPlaying()) {
          break;
        }

        const scheduleVersion = scheduleVersionRef.current;

        const ctx = audioContextRef.current;
        const now = ctx.currentTime;

        // Don't reschedule too frequently
        if (now - lastScheduleTimeRef.current < RESCHEDULE_INTERVAL) {
          continue;
        }
        lastScheduleTimeRef.current = now;

        const audioClips = getAudioClips();
        const scheduleAheadTime = getScheduleAheadTime();

        // Find clips that need to be scheduled
        for (const { clip, asset, trackVolume, trackMuted } of audioClips) {
          if (trackMuted) continue;

          // Calculate clip timing
          const safeSpeed = clip.speed > 0 ? clip.speed : 1;
          const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
          const clipEnd = clip.place.timelineInSec + clipDuration;

          // Skip clips that have ended
          if (currentTime >= clipEnd) continue;

          // Skip clips that are too far in the future (using dynamic window)
          if (clip.place.timelineInSec > currentTime + scheduleAheadTime) continue;

          // Check if already scheduled
          if (scheduledSourcesRef.current.has(clip.id)) continue;

          // Load audio buffer
          const audioUrl = asset.proxyUrl || asset.uri;
          const audioBuffer = await loadAudioBuffer(asset.id, audioUrl);
          if (!audioBuffer) continue;

          // Abort stale async scheduling work (pause/seek/unmount may have happened
          // while waiting for network/decode).
          if (
            scheduleVersion !== scheduleVersionRef.current ||
            !audioContextRef.current ||
            !masterGainRef.current ||
            !enabled ||
            !getLiveIsPlaying()
          ) {
            rescheduleRequestedRef.current = enabled && getLiveIsPlaying();
            continue schedulingPass;
          }

          // Re-check after await: another pass may have scheduled this clip.
          if (scheduledSourcesRef.current.has(clip.id)) {
            continue;
          }

          // Create source node
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.playbackRate.value = playbackRate * safeSpeed;

          // Create gain node for this clip
          const gainNode = ctx.createGain();
          const clipVolume = calculateClipVolume(clip, trackVolume);
          gainNode.gain.value = isMuted ? 0 : volume * clipVolume;

          // Connect: source -> gainNode -> masterGain -> destination
          source.connect(gainNode);
          gainNode.connect(masterGainRef.current);

          // Calculate start timing
          const timeIntoClip = Math.max(0, currentTime - clip.place.timelineInSec);
          const sourceOffset = clip.range.sourceInSec + timeIntoClip * safeSpeed;
          const startDelay = Math.max(0, clip.place.timelineInSec - currentTime);

          // Calculate duration to stop at clip's source out point
          const remainingSourceDuration = clip.range.sourceOutSec - sourceOffset;
          const audioDuration = Math.max(0, remainingSourceDuration);

          // Schedule playback with duration to stop at clip end
          const scheduledStartTime = now + startDelay;
          source.start(scheduledStartTime, sourceOffset, audioDuration);

          // Track the scheduled source
          scheduledSourcesRef.current.set(clip.id, {
            source,
            gainNode,
            clipId: clip.id,
            startTime: scheduledStartTime,
          });

          // Clean up when source ends.
          // Only delete map entry if this exact source is still the active one.
          source.onended = () => {
            const active = scheduledSourcesRef.current.get(clip.id);
            if (active?.source === source) {
              scheduledSourcesRef.current.delete(clip.id);
            }
            source.disconnect();
            gainNode.disconnect();
          };
        }

        // Guard post-loop updates as well in case invalidation happened mid-loop.
        if (scheduleVersion !== scheduleVersionRef.current) {
          rescheduleRequestedRef.current = enabled && getLiveIsPlaying();
          continue;
        }

        // Update volume on existing sources
        scheduledSourcesRef.current.forEach((scheduled) => {
          const clipData = audioClips.find((c) => c.clip.id === scheduled.clipId);
          if (clipData) {
            const clipVolume = calculateClipVolume(clipData.clip, clipData.trackVolume);
            scheduled.gainNode.gain.value = isMuted ? 0 : volume * clipVolume;
            const updateSpeed = clipData.clip.speed > 0 ? clipData.clip.speed : 1;
            scheduled.source.playbackRate.value = playbackRate * updateSpeed;
          }
        });

        // Report audio time to PlaybackController for A/V sync tracking
        if (ctx && scheduledSourcesRef.current.size > 0) {
          // Find the first active clip to calculate audio timeline position
          const firstActiveClip = audioClips.find((c) => {
            const syncSpeed = c.clip.speed > 0 ? c.clip.speed : 1;
            const clipEnd =
              c.clip.place.timelineInSec +
              (c.clip.range.sourceOutSec - c.clip.range.sourceInSec) / syncSpeed;
            return currentTime >= c.clip.place.timelineInSec && currentTime < clipEnd;
          });

          if (firstActiveClip) {
            // Report the current audio time to the controller
            // This enables drift detection and correction
            playbackController.reportAudioTime(currentTime);
          }
        }
      } while (rescheduleRequestedRef.current);
    } finally {
      isSchedulingRef.current = false;
    }
  }, [
    enabled,
    isPlaying,
    currentTime,
    volume,
    isMuted,
    playbackRate,
    getAudioClips,
    loadAudioBuffer,
    calculateClipVolume,
    getScheduleAheadTime,
    getLiveIsPlaying,
  ]);

  // Handle play/pause
  useEffect(() => {
    if (!enabled) {
      stopAllSources();
    }
  }, [enabled, stopAllSources]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    if (isPlaying) {
      // Initialize audio context if needed
      initAudio()
        .then(() => {
          if (!cancelled) {
            void scheduleAudioClips();
          }
        })
        .catch((error) => {
          logger.error('Failed to initialize audio', { error });
        });
    } else {
      // Stop all sources when pausing
      stopAllSources();
    }

    return () => {
      cancelled = true;
    };
  }, [enabled, isPlaying, initAudio, scheduleAudioClips, stopAllSources]);

  // Schedule audio periodically during playback
  useEffect(() => {
    if (!enabled || !isPlaying) return;

    const intervalId = setInterval(() => {
      scheduleAudioClips();
    }, RESCHEDULE_INTERVAL * 1000);

    return () => clearInterval(intervalId);
  }, [enabled, isPlaying, scheduleAudioClips]);

  // Handle seek - stop and reschedule with velocity tracking
  const lastSeekTimeRef = useRef(currentTime);
  const lastSeekTimestampRef = useRef(Date.now());
  // Note: seekVelocityRef is defined above with getScheduleAheadTime

  useEffect(() => {
    if (!enabled) return;

    const now = Date.now();
    const previousTime = lastSeekTimeRef.current;
    const previousTimestamp = lastSeekTimestampRef.current;
    const timeDiff = Math.abs(currentTime - previousTime);
    const timestampDiff = (now - previousTimestamp) / 1000; // seconds

    // Always advance baseline refs to avoid accumulated-delta false positives
    // during normal playback (which can cause repeated stop/reschedule glitches).
    lastSeekTimeRef.current = currentTime;
    lastSeekTimestampRef.current = now;

    // Ignore tiny changes and invalid timing intervals.
    if (timeDiff < SEEK_DETECTION_DELTA_THRESHOLD || timestampDiff <= 0) {
      return;
    }

    // Calculate seek velocity (timeline seconds per real second)
    // for dynamic scheduling and diagnostics.
    const seekVelocity = timeDiff / timestampDiff;
    seekVelocityRef.current = seekVelocity;

    // When paused, playback sources are already stopped via play/pause effect.
    // Do not force rescheduling here.
    if (!isPlaying) {
      return;
    }

    // Distinguish natural playback progression from real seeks/jumps.
    // If observed delta is close to expected real-time progression, treat it
    // as normal playback and skip stop/reschedule to avoid crackle artifacts.
    const expectedDelta = Math.abs(playbackRate) * timestampDiff;
    const tolerance = Math.max(PLAYBACK_PROGRESS_TOLERANCE, expectedDelta * 0.35);
    const isLikelyNaturalPlayback = timeDiff <= expectedDelta + tolerance;

    if (isLikelyNaturalPlayback) {
      return;
    }

    // Stop current sources on real seek/jump
    stopAllSources();

    // Reschedule immediately if still playing
    lastScheduleTimeRef.current = 0;
    void scheduleAudioClips();

    // Log if rapid seeking detected (for performance monitoring)
    if (seekVelocityRef.current > RAPID_SEEK_VELOCITY_THRESHOLD) {
      logger.debug('Rapid seek detected', {
        velocity: seekVelocityRef.current.toFixed(1),
        timeDiff: timeDiff.toFixed(2),
      });
    }
  }, [enabled, currentTime, isPlaying, playbackRate, stopAllSources, scheduleAudioClips]);

  // Update master volume
  useEffect(() => {
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  // Cleanup on unmount
  useEffect(() => {
    // Capture ref values at effect creation time for safe cleanup access
    const audioBuffers = audioBuffersRef.current;
    const retryTimeouts = retryTimeoutsRef.current;
    const failedLoads = failedLoadsRef.current;

    return () => {
      stopAllSources();

      // Clear all pending retry timeouts
      for (const timeoutId of retryTimeouts.values()) {
        clearTimeout(timeoutId);
      }
      retryTimeouts.clear();

      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      audioBuffers.clear();
      failedLoads.clear();
      isAudioReadyRef.current = false;
    };
  }, [stopAllSources]);

  return {
    initAudio,
    isAudioReady: isAudioReadyRef.current,
    retryLoad,
    failedAssets: Array.from(failedLoadsRef.current.keys()),
  };
}

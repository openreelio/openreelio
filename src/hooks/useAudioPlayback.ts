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

const SCHEDULE_AHEAD_TIME = 0.5; // Schedule audio 500ms ahead
const RESCHEDULE_INTERVAL = 0.25; // Check for rescheduling every 250ms

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
          logger.debug('Scheduling audio load retry', { assetId, retryDelay, attempt: currentAttempt });

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
    [getRetryDelay]
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
    [assets, loadAudioBuffer]
  );

  /**
   * Get all audio clips from sequence
   */
  const getAudioClips = useCallback((): Array<{ clip: Clip; asset: Asset; trackVolume: number; trackMuted: boolean }> => {
    if (!sequence) return [];

    const audioClips: Array<{ clip: Clip; asset: Asset; trackVolume: number; trackMuted: boolean }> = [];

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

  /**
   * Schedule audio clips for playback
   */
  const scheduleAudioClips = useCallback(async () => {
    if (!audioContextRef.current || !masterGainRef.current || !enabled) return;
    if (!isPlaying) return;

    const ctx = audioContextRef.current;
    const now = ctx.currentTime;

    // Don't reschedule too frequently
    if (now - lastScheduleTimeRef.current < RESCHEDULE_INTERVAL) return;
    lastScheduleTimeRef.current = now;

    const audioClips = getAudioClips();

    // Find clips that need to be scheduled
    for (const { clip, asset, trackVolume, trackMuted } of audioClips) {
      if (trackMuted) continue;

      // Calculate clip timing
      const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
      const clipEnd = clip.place.timelineInSec + clipDuration;

      // Skip clips that have ended
      if (currentTime >= clipEnd) continue;

      // Skip clips that are too far in the future
      if (clip.place.timelineInSec > currentTime + SCHEDULE_AHEAD_TIME) continue;

      // Check if already scheduled
      if (scheduledSourcesRef.current.has(clip.id)) continue;

      // Load audio buffer
      const audioUrl = asset.proxyUrl || asset.uri;
      const audioBuffer = await loadAudioBuffer(asset.id, audioUrl);
      if (!audioBuffer) continue;

      // Create source node
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = playbackRate * clip.speed;

      // Create gain node for this clip
      const gainNode = ctx.createGain();
      const clipVolume = calculateClipVolume(clip, trackVolume);
      gainNode.gain.value = isMuted ? 0 : volume * clipVolume;

      // Connect: source -> gainNode -> masterGain -> destination
      source.connect(gainNode);
      gainNode.connect(masterGainRef.current);

      // Calculate start timing
      const timeIntoClip = Math.max(0, currentTime - clip.place.timelineInSec);
      const sourceOffset = clip.range.sourceInSec + (timeIntoClip * clip.speed);
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

      // Clean up when source ends
      source.onended = () => {
        scheduledSourcesRef.current.delete(clip.id);
        source.disconnect();
        gainNode.disconnect();
      };
    }

    // Update volume on existing sources
    scheduledSourcesRef.current.forEach((scheduled) => {
      const clipData = audioClips.find(c => c.clip.id === scheduled.clipId);
      if (clipData) {
        const clipVolume = calculateClipVolume(clipData.clip, clipData.trackVolume);
        scheduled.gainNode.gain.value = isMuted ? 0 : volume * clipVolume;
        scheduled.source.playbackRate.value = playbackRate * clipData.clip.speed;
      }
    });
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
  ]);

  // Handle play/pause
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    if (isPlaying) {
      // Initialize audio context if needed
      initAudio().then(() => {
        if (!cancelled) {
          void scheduleAudioClips();
        }
      }).catch((error) => {
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

  // Handle seek - stop and reschedule
  const lastSeekTimeRef = useRef(currentTime);
  useEffect(() => {
    if (!enabled) return;

    // Only handle significant seeks (more than 0.1 second difference)
    const timeDiff = Math.abs(currentTime - lastSeekTimeRef.current);
    if (timeDiff < 0.1) return;
    lastSeekTimeRef.current = currentTime;

    // Stop current sources on seek
    stopAllSources();

    // Reschedule if playing
    if (isPlaying) {
      lastScheduleTimeRef.current = 0; // Allow immediate rescheduling
      void scheduleAudioClips();
    }
  }, [enabled, currentTime, isPlaying, stopAllSources, scheduleAudioClips]);

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

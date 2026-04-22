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

import { useRef, useCallback, useEffect, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useAudioMixerStore, type StereoLevels } from '@/stores/audioMixerStore';
import { playbackController } from '@/services/PlaybackController';
import type { Sequence, Asset, Clip } from '@/types';
import { createLogger } from '@/services/logger';
import { collectPlaybackAudioClips } from '@/utils/audioPlayback';
import { clampClipPan, clampClipVolumeDb, getClipFadeFactor } from '@/utils/clipAudio';
import { calculatePeak, linearToDb } from '@/utils/audioMeter';
import {
  assetMatchesWorkspaceRelativePath,
  clearCachedAudioPreview,
  decodeAssetAudioBuffer,
} from '@/utils/audioPreview';
import {
  connectSourceToDestination,
  resolveMasterOutputGain,
  resolveTrackPlaybackRouting,
} from '@/utils/audioRouting';
import { getClipSourceTimeAtTimelineTime, getClipTimelineEndSec } from '@/utils/clipTiming';

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
  pannerNode: StereoPannerNode;
  clipId: string;
  startTime: number;
}

interface TrackAudioChain {
  inputGain: GainNode;
  volumeGain: GainNode;
  panner: StereoPannerNode;
  splitter: ChannelSplitterNode;
  leftAnalyser: AnalyserNode;
  rightAnalyser: AnalyserNode;
  leftBuffer: Uint8Array<ArrayBuffer>;
  rightBuffer: Uint8Array<ArrayBuffer>;
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

/** Level metering update interval in ms */
const METER_UPDATE_INTERVAL_MS = 50;

/** FFT size for level analyzers */
const ANALYSER_FFT_SIZE = 2048;

/** Silence floor used by mixer meters */
const SILENCE_DB = -60;

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
  const masterSplitterRef = useRef<ChannelSplitterNode | null>(null);
  const masterLeftAnalyserRef = useRef<AnalyserNode | null>(null);
  const masterRightAnalyserRef = useRef<AnalyserNode | null>(null);
  const masterLeftBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const masterRightBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const trackChainsRef = useRef<Map<string, TrackAudioChain>>(new Map());
  const meteringIntervalRef = useRef<number | null>(null);
  const isAudioReadyRef = useRef(false);
  const lastScheduleTimeRef = useRef(0);
  const [isAudioReady, setIsAudioReady] = useState(false);
  const [failedAssetIds, setFailedAssetIds] = useState<string[]>([]);
  const rescheduleAudioRef = useRef<() => void>(() => {});

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
  const trackRoutingSnapshot = useAudioMixerStore((state) =>
    Array.from(state.trackStates.entries())
      .map(
        ([trackId, trackState]) =>
          `${trackId}:${trackState.volumeDb}:${trackState.pan}:${trackState.muted ? 1 : 0}`,
      )
      .join('|'),
  );
  const soloedTrackIdsSnapshot = useAudioMixerStore((state) =>
    Array.from(state.soloedTrackIds).sort().join('|'),
  );
  const mixerMasterVolumeDb = useAudioMixerStore((state) => state.masterState.volumeDb);
  const mixerMasterMuted = useAudioMixerStore((state) => state.masterState.muted);
  const updateTrackLevels = useAudioMixerStore((state) => state.updateTrackLevels);
  const updateMasterLevels = useAudioMixerStore((state) => state.updateMasterLevels);

  const getLiveIsPlaying = useCallback((): boolean => {
    return usePlaybackStore.getState().isPlaying;
  }, []);

  const syncFailedAssetIds = useCallback(() => {
    setFailedAssetIds(Array.from(failedLoadsRef.current.keys()));
  }, []);

  const getFallbackTrackVolume = useCallback(
    (trackId: string): number =>
      sequence?.tracks.find((track) => track.id === trackId)?.volume ?? 1,
    [sequence],
  );

  const ensureTrackChain = useCallback((trackId: string): TrackAudioChain | null => {
    if (!audioContextRef.current || !masterGainRef.current) {
      return null;
    }

    const existing = trackChainsRef.current.get(trackId);
    if (existing) {
      return existing;
    }

    const ctx = audioContextRef.current;
    const inputGain = ctx.createGain();
    const volumeGain = ctx.createGain();
    const panner = ctx.createStereoPanner();
    const splitter = ctx.createChannelSplitter(2);
    const leftAnalyser = ctx.createAnalyser();
    const rightAnalyser = ctx.createAnalyser();

    leftAnalyser.fftSize = ANALYSER_FFT_SIZE;
    rightAnalyser.fftSize = ANALYSER_FFT_SIZE;

    const bufferLength = leftAnalyser.frequencyBinCount;
    const leftBuffer = new Uint8Array(new ArrayBuffer(bufferLength));
    const rightBuffer = new Uint8Array(new ArrayBuffer(bufferLength));

    inputGain.connect(volumeGain);
    volumeGain.connect(panner);
    panner.connect(splitter);
    splitter.connect(leftAnalyser, 0);
    splitter.connect(rightAnalyser, 1);
    panner.connect(masterGainRef.current);

    const chain: TrackAudioChain = {
      inputGain,
      volumeGain,
      panner,
      splitter,
      leftAnalyser,
      rightAnalyser,
      leftBuffer,
      rightBuffer,
    };

    trackChainsRef.current.set(trackId, chain);
    return chain;
  }, []);

  const disconnectTrackChain = useCallback((trackId: string) => {
    const chain = trackChainsRef.current.get(trackId);
    if (!chain) {
      return;
    }

    try {
      chain.inputGain.disconnect();
      chain.volumeGain.disconnect();
      chain.panner.disconnect();
      chain.splitter.disconnect();
      chain.leftAnalyser.disconnect();
      chain.rightAnalyser.disconnect();
    } catch {
      // Nodes may already be disconnected.
    }

    trackChainsRef.current.delete(trackId);
  }, []);

  const updateTrackChainState = useCallback(
    (trackId: string) => {
      const chain = trackChainsRef.current.get(trackId);
      if (!chain) {
        return;
      }

      const { trackStates, soloedTrackIds, masterState } = useAudioMixerStore.getState();

      const routing = resolveTrackPlaybackRouting({
        trackId,
        fallbackTrackVolume: getFallbackTrackVolume(trackId),
        trackStates,
        soloedTrackIds,
        masterMuted: masterState.muted,
      });

      chain.volumeGain.gain.value = routing.trackGain;
      chain.panner.pan.value = routing.trackPan;
    },
    [getFallbackTrackVolume],
  );

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
      setIsAudioReady(true);
      return;
    }

    // Create new AudioContext
    audioContextRef.current = new AudioContext();

    // Create master output chain with split analyzers so mixer meters reflect
    // the same signal path that reaches the speakers.
    masterGainRef.current = audioContextRef.current.createGain();
    masterGainRef.current.gain.value = resolveMasterOutputGain(volume, isMuted, {
      volumeDb: mixerMasterVolumeDb,
      muted: mixerMasterMuted,
      levels: { left: SILENCE_DB, right: SILENCE_DB },
    });
    masterSplitterRef.current = audioContextRef.current.createChannelSplitter(2);
    masterLeftAnalyserRef.current = audioContextRef.current.createAnalyser();
    masterRightAnalyserRef.current = audioContextRef.current.createAnalyser();
    masterLeftAnalyserRef.current.fftSize = ANALYSER_FFT_SIZE;
    masterRightAnalyserRef.current.fftSize = ANALYSER_FFT_SIZE;
    const bufferLength = masterLeftAnalyserRef.current.frequencyBinCount;
    masterLeftBufferRef.current = new Uint8Array(new ArrayBuffer(bufferLength));
    masterRightBufferRef.current = new Uint8Array(new ArrayBuffer(bufferLength));

    masterGainRef.current.connect(masterSplitterRef.current);
    masterSplitterRef.current.connect(masterLeftAnalyserRef.current, 0);
    masterSplitterRef.current.connect(masterRightAnalyserRef.current, 1);
    masterGainRef.current.connect(audioContextRef.current.destination);

    // Resume if needed
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    isAudioReadyRef.current = true;
    setIsAudioReady(true);
  }, [isMuted, mixerMasterMuted, mixerMasterVolumeDb, volume]);

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
    async (asset: Asset, isRetry = false): Promise<AudioBuffer | null> => {
      const assetId = asset.id;
      // Check cache first
      const cached = audioBuffersRef.current.get(assetId);
      if (cached) {
        // Clear any failed state if we have a cached buffer
        if (failedLoadsRef.current.delete(assetId)) {
          syncFailedAssetIds();
        }
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
        logger.debug('Loading audio buffer', { assetId, isRetry });

        const { buffer: audioBuffer, usedPreview } = await decodeAssetAudioBuffer(
          audioContextRef.current,
          asset,
        );

        // Cache the buffer and clear failed state
        audioBuffersRef.current.set(assetId, audioBuffer);
        if (failedLoadsRef.current.delete(assetId)) {
          syncFailedAssetIds();
        }

        if (usedPreview) {
          logger.warn('Using generated audio preview fallback for playback', { assetId });
        }

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
        syncFailedAssetIds();

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
            void loadAudioBuffer(asset, true);
          }, retryDelay);

          retryTimeoutsRef.current.set(assetId, timeoutId);
        }

        return null;
      }
    },
    [getRetryDelay, syncFailedAssetIds],
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
      syncFailedAssetIds();

      // Clear any pending retry
      const existingTimeout = retryTimeoutsRef.current.get(assetId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        retryTimeoutsRef.current.delete(assetId);
      }

      const buffer = await loadAudioBuffer(asset, true);

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
    trackId: string;
    trackVolume: number;
    trackMuted: boolean;
  }> => {
    return collectPlaybackAudioClips(sequence, assets);
  }, [sequence, assets]);

  useEffect(() => {
    if (!isAudioReady) {
      return;
    }

    const activeTrackIds = new Set(sequence?.tracks.map((track) => track.id) ?? []);

    for (const trackId of activeTrackIds) {
      ensureTrackChain(trackId);
      updateTrackChainState(trackId);
    }

    for (const trackId of Array.from(trackChainsRef.current.keys())) {
      if (!activeTrackIds.has(trackId)) {
        disconnectTrackChain(trackId);
      }
    }
  }, [disconnectTrackChain, ensureTrackChain, isAudioReady, sequence, updateTrackChainState]);

  useEffect(() => {
    if (!isAudioReady) {
      return;
    }

    for (const trackId of trackChainsRef.current.keys()) {
      updateTrackChainState(trackId);
    }
  }, [
    isAudioReady,
    trackRoutingSnapshot,
    soloedTrackIdsSnapshot,
    mixerMasterMuted,
    updateTrackChainState,
  ]);

  useEffect(() => {
    if (!masterGainRef.current) {
      return;
    }

    masterGainRef.current.gain.value = resolveMasterOutputGain(volume, isMuted, {
      volumeDb: mixerMasterVolumeDb,
      muted: mixerMasterMuted,
      levels: { left: SILENCE_DB, right: SILENCE_DB },
    });
  }, [isMuted, mixerMasterMuted, mixerMasterVolumeDb, volume]);

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
        scheduled.pannerNode.disconnect();
      } catch {
        // Already stopped
      }
    });
    scheduledSourcesRef.current.clear();
  }, []);

  /**
   * Calculate clip-local gain.
   * Track/master gain is applied by the shared routing graph so the playback
   * signal and mixer meters stay on the same path.
   */
  const calculateClipVolume = useCallback((clip: Clip): number => {
    // Apply clip mute first
    if (clip.audio?.muted) return 0;

    // Convert clip dB to linear gain
    const clipVolumeDb = clampClipVolumeDb(clip.audio?.volumeDb ?? 0);
    return Math.pow(10, clipVolumeDb / 20);
  }, []);

  const updateLevels = useCallback(() => {
    for (const [trackId, chain] of trackChainsRef.current) {
      chain.leftAnalyser.getByteTimeDomainData(chain.leftBuffer);
      chain.rightAnalyser.getByteTimeDomainData(chain.rightBuffer);

      const levels: StereoLevels = {
        left: linearToDb(calculatePeak(chain.leftBuffer), SILENCE_DB),
        right: linearToDb(calculatePeak(chain.rightBuffer), SILENCE_DB),
      };

      updateTrackLevels(trackId, levels);
    }

    if (
      masterLeftAnalyserRef.current &&
      masterRightAnalyserRef.current &&
      masterLeftBufferRef.current &&
      masterRightBufferRef.current
    ) {
      masterLeftAnalyserRef.current.getByteTimeDomainData(masterLeftBufferRef.current);
      masterRightAnalyserRef.current.getByteTimeDomainData(masterRightBufferRef.current);
      updateMasterLevels({
        left: linearToDb(calculatePeak(masterLeftBufferRef.current), SILENCE_DB),
        right: linearToDb(calculatePeak(masterRightBufferRef.current), SILENCE_DB),
      });
    }
  }, [updateMasterLevels, updateTrackLevels]);

  const stopMetering = useCallback(() => {
    if (meteringIntervalRef.current !== null) {
      window.clearInterval(meteringIntervalRef.current);
      meteringIntervalRef.current = null;
    }

    for (const trackId of trackChainsRef.current.keys()) {
      updateTrackLevels(trackId, { left: SILENCE_DB, right: SILENCE_DB });
    }
    updateMasterLevels({ left: SILENCE_DB, right: SILENCE_DB });
  }, [updateMasterLevels, updateTrackLevels]);

  useEffect(() => {
    if (!enabled || !isPlaying || !isAudioReady) {
      stopMetering();
      return;
    }

    if (meteringIntervalRef.current !== null) {
      return;
    }

    updateLevels();
    meteringIntervalRef.current = window.setInterval(updateLevels, METER_UPDATE_INTERVAL_MS);

    return () => {
      stopMetering();
    };
  }, [enabled, isAudioReady, isPlaying, stopMetering, updateLevels]);

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
        const { trackStates, soloedTrackIds, masterState } = useAudioMixerStore.getState();

        // Find clips that need to be scheduled
        for (const { clip, asset, trackId, trackVolume, trackMuted } of audioClips) {
          if (trackMuted) continue;

          const trackRouting = resolveTrackPlaybackRouting({
            trackId,
            fallbackTrackVolume: trackVolume,
            trackStates,
            soloedTrackIds,
            masterMuted: masterState.muted,
          });
          if (!trackRouting.isAudible) continue;

          const trackChain = ensureTrackChain(trackId);
          if (!trackChain) continue;
          updateTrackChainState(trackId);

          // Calculate clip timing
          const safeSpeed = clip.speed > 0 ? clip.speed : 1;
          const clipEnd = getClipTimelineEndSec(clip);

          // Skip clips that have ended
          if (currentTime >= clipEnd) continue;

          // Skip clips that are too far in the future (using dynamic window)
          if (clip.place.timelineInSec > currentTime + scheduleAheadTime) continue;

          // Check if already scheduled
          if (scheduledSourcesRef.current.has(clip.id)) continue;

          // Load audio buffer
          const audioBuffer = await loadAudioBuffer(asset);
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
          const clipVolume = calculateClipVolume(clip);
          const clipOffset = Math.max(0, currentTime - clip.place.timelineInSec);
          const fadeFactor = getClipFadeFactor(clip, clipOffset);
          gainNode.gain.value = clipVolume * fadeFactor;

          const pannerNode = ctx.createStereoPanner();
          pannerNode.pan.value = clampClipPan(clip.audio?.pan ?? 0);

          connectSourceToDestination(source, gainNode, pannerNode, trackChain.inputGain);

          // Calculate start timing
          const sourceOffset = getClipSourceTimeAtTimelineTime(clip, currentTime);
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
            pannerNode,
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
            pannerNode.disconnect();
          };
        }

        // Guard post-loop updates as well in case invalidation happened mid-loop.
        if (scheduleVersion !== scheduleVersionRef.current) {
          rescheduleRequestedRef.current = enabled && getLiveIsPlaying();
          continue;
        }

        // Update volume on existing sources and stop sources that are no longer valid.
        const staleClipIds: string[] = [];
        scheduledSourcesRef.current.forEach((scheduled, clipId) => {
          const clipData = audioClips.find((c) => c.clip.id === scheduled.clipId);
          if (clipData) {
            const clipVolume = calculateClipVolume(clipData.clip);
            const clipOffset = Math.max(0, currentTime - clipData.clip.place.timelineInSec);
            const fadeFactor = getClipFadeFactor(clipData.clip, clipOffset);
            scheduled.gainNode.gain.value = clipVolume * fadeFactor;
            scheduled.pannerNode.pan.value = clampClipPan(clipData.clip.audio?.pan ?? 0);
            const updateSpeed = clipData.clip.speed > 0 ? clipData.clip.speed : 1;
            scheduled.source.playbackRate.value = playbackRate * updateSpeed;
          } else {
            staleClipIds.push(clipId);
          }
        });

        for (const clipId of staleClipIds) {
          const scheduled = scheduledSourcesRef.current.get(clipId);
          if (!scheduled) {
            continue;
          }

          try {
            scheduled.source.stop();
          } catch {
            // Source may already be ending.
          }

          scheduled.source.disconnect();
          scheduled.gainNode.disconnect();
          scheduled.pannerNode.disconnect();
          scheduledSourcesRef.current.delete(clipId);
        }

        // Report audio time to PlaybackController for A/V sync tracking
        if (ctx && scheduledSourcesRef.current.size > 0) {
          // Find the first active clip to calculate audio timeline position
          const firstActiveClip = audioClips.find((c) => {
            const clipEnd = getClipTimelineEndSec(c.clip);
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
    playbackRate,
    getAudioClips,
    loadAudioBuffer,
    calculateClipVolume,
    getScheduleAheadTime,
    getLiveIsPlaying,
    ensureTrackChain,
    updateTrackChainState,
  ]);

  useEffect(() => {
    let disposed = false;
    let unlistenModified: UnlistenFn | null = null;
    let unlistenRemoved: UnlistenFn | null = null;

    const clearCachedAssets = (relativePath: string) => {
      const affectedAssetIds = Array.from(assets.values())
        .filter((asset) => assetMatchesWorkspaceRelativePath(asset, relativePath))
        .map((asset) => asset.id);

      if (affectedAssetIds.length === 0) {
        return;
      }

      for (const assetId of affectedAssetIds) {
        audioBuffersRef.current.delete(assetId);
        clearCachedAudioPreview(assetId);
        failedLoadsRef.current.delete(assetId);

        const retryTimeout = retryTimeoutsRef.current.get(assetId);
        if (retryTimeout) {
          clearTimeout(retryTimeout);
          retryTimeoutsRef.current.delete(assetId);
        }
      }

      syncFailedAssetIds();
      stopAllSources();

      if (enabled && getLiveIsPlaying()) {
        rescheduleAudioRef.current();
      }
    };

    const setupListeners = async (): Promise<void> => {
      try {
        unlistenModified = await listen<{ relativePath: string }>(
          'workspace:file-modified',
          ({ payload }) => {
            clearCachedAssets(payload.relativePath);
          },
        );
        unlistenRemoved = await listen<{ relativePath: string }>(
          'workspace:file-removed',
          ({ payload }) => {
            clearCachedAssets(payload.relativePath);
          },
        );
      } catch {
        // Workspace listeners are only available in the desktop runtime.
      }

      if (disposed) {
        unlistenModified?.();
        unlistenRemoved?.();
      }
    };

    void setupListeners();

    return () => {
      disposed = true;
      unlistenModified?.();
      unlistenRemoved?.();
    };
  }, [assets, enabled, getLiveIsPlaying, stopAllSources, syncFailedAssetIds]);

  useEffect(() => {
    rescheduleAudioRef.current = () => {
      lastScheduleTimeRef.current = 0;
      void scheduleAudioClips();
    };
  }, [scheduleAudioClips]);

  // Handle play/pause and enabled toggle
  useEffect(() => {
    if (!enabled) {
      stopAllSources();

      // Clear all pending retry timeouts to prevent resource leaks
      // when audio playback is disabled (e.g., component deactivation).
      for (const timeoutId of retryTimeoutsRef.current.values()) {
        clearTimeout(timeoutId);
      }
      retryTimeoutsRef.current.clear();
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

  // Cleanup on unmount
  useEffect(() => {
    // Capture ref values at effect creation time for safe cleanup access
    const audioBuffers = audioBuffersRef.current;
    const retryTimeouts = retryTimeoutsRef.current;
    const failedLoads = failedLoadsRef.current;
    const trackChains = trackChainsRef.current;

    return () => {
      stopAllSources();
      stopMetering();

      // Clear all pending retry timeouts
      for (const timeoutId of retryTimeouts.values()) {
        clearTimeout(timeoutId);
      }
      retryTimeouts.clear();

      for (const trackId of Array.from(trackChains.keys())) {
        disconnectTrackChain(trackId);
      }

      try {
        masterGainRef.current?.disconnect();
        masterSplitterRef.current?.disconnect();
        masterLeftAnalyserRef.current?.disconnect();
        masterRightAnalyserRef.current?.disconnect();
      } catch {
        // Nodes may already be disconnected.
      }

      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      masterGainRef.current = null;
      masterSplitterRef.current = null;
      masterLeftAnalyserRef.current = null;
      masterRightAnalyserRef.current = null;
      masterLeftBufferRef.current = null;
      masterRightBufferRef.current = null;
      audioBuffers.clear();
      failedLoads.clear();
      isAudioReadyRef.current = false;
      setIsAudioReady(false);
    };
  }, [disconnectTrackChain, stopAllSources, stopMetering]);

  return {
    initAudio,
    isAudioReady,
    retryLoad,
    failedAssets: failedAssetIds,
  };
}

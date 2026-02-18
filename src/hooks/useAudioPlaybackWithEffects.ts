/**
 * useAudioPlaybackWithEffects Hook
 *
 * Extends useAudioPlayback with real-time audio effect chain support.
 * Integrates with the audioEffectFactory to apply per-clip audio effects
 * during playback preview.
 *
 * Features:
 * - Per-clip audio effect chain creation
 * - Real-time parameter updates
 * - Proper cleanup on clip changes
 * - Support for all Web Audio effect types
 */

import { useRef, useCallback, useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Sequence, Asset, Clip, Effect } from '@/types';
import { createLogger } from '@/services/logger';
import { collectPlaybackAudioClips } from '@/utils/audioPlayback';
import { clampClipPan, clampClipVolumeDb, getClipFadeFactor } from '@/utils/clipAudio';
import {
  createAudioEffectNode,
  updateAudioEffectNode,
  getEffectNodeType,
  type AudioEffectNode,
  type EffectNodeConfig,
} from '@/services/audioEffectFactory';

const logger = createLogger('AudioPlaybackWithEffects');

// =============================================================================
// Types
// =============================================================================

export interface UseAudioPlaybackWithEffectsOptions {
  /** Sequence containing audio clips */
  sequence: Sequence | null;
  /** Assets map for looking up audio sources */
  assets: Map<string, Asset>;
  /** Whether to enable audio playback */
  enabled?: boolean;
  /** Function to look up effects by ID */
  getEffectById?: (effectId: string) => Effect | undefined;
}

export interface UseAudioPlaybackWithEffectsReturn {
  /** Initialize audio context (must be called on user interaction) */
  initAudio: () => Promise<void>;
  /** Whether audio context is initialized */
  isAudioReady: boolean;
  /** Retry loading a failed asset */
  retryLoad: (assetId: string) => Promise<boolean>;
  /** Get list of assets that failed to load */
  failedAssets: string[];
  /** Update an effect parameter for a clip in real-time */
  updateClipEffect: (clipId: string, effectId: string, paramName: string, value: number) => void;
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  pannerNode: StereoPannerNode;
  effectNodes: AudioEffectNode[];
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

const SCHEDULE_AHEAD_TIME = 0.5;
const RESCHEDULE_INTERVAL = 0.25;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 10000;
const SEEK_DETECTION_DELTA_THRESHOLD = 0.1;
const PLAYBACK_PROGRESS_TOLERANCE = 0.08;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract effect type string from EffectType union
 */
function toEffectTypeId(effectType: Effect['effectType']): string {
  if (typeof effectType === 'string') return effectType;
  return effectType.custom;
}

/**
 * Extract numeric parameters from effect params
 */
function extractNumericParams(params: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Check if effect type is an audio effect
 */
function isAudioEffect(effectType: string): boolean {
  return getEffectNodeType(effectType) !== null;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useAudioPlaybackWithEffects({
  sequence,
  assets,
  enabled = true,
  getEffectById,
}: UseAudioPlaybackWithEffectsOptions): UseAudioPlaybackWithEffectsReturn {
  // Audio context and nodes
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const scheduledSourcesRef = useRef<Map<string, ScheduledSource>>(new Map());
  const scheduleVersionRef = useRef(0);
  const isSchedulingRef = useRef(false);
  const rescheduleRequestedRef = useRef(false);
  const masterGainRef = useRef<GainNode | null>(null);
  const [isAudioReady, setIsAudioReady] = useState(false);
  const lastScheduleTimeRef = useRef(0);

  // Failed loads tracking
  const failedLoadsRef = useRef<Map<string, FailedLoadInfo>>(new Map());
  const retryTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Playback state
  const { currentTime, isPlaying, volume, isMuted, playbackRate } = usePlaybackStore();
  const isPlayingRef = useRef(isPlaying);

  const getLiveIsPlaying = useCallback((): boolean => {
    return isPlayingRef.current;
  }, []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // -------------------------------------------------------------------------
  // Audio Context Initialization
  // -------------------------------------------------------------------------

  const initAudio = useCallback(async () => {
    if (audioContextRef.current) {
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      setIsAudioReady(true);
      return;
    }

    audioContextRef.current = new AudioContext();
    masterGainRef.current = audioContextRef.current.createGain();
    masterGainRef.current.connect(audioContextRef.current.destination);

    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    setIsAudioReady(true);
  }, []);

  // -------------------------------------------------------------------------
  // Retry Delay Calculation
  // -------------------------------------------------------------------------

  const getRetryDelay = useCallback((attemptCount: number): number => {
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attemptCount - 1);
    return Math.min(delay, RETRY_MAX_DELAY_MS);
  }, []);

  // -------------------------------------------------------------------------
  // Audio Buffer Loading
  // -------------------------------------------------------------------------

  const loadAudioBuffer = useCallback(
    async (assetId: string, assetUri: string, isRetry = false): Promise<AudioBuffer | null> => {
      const cached = audioBuffersRef.current.get(assetId);
      if (cached) {
        failedLoadsRef.current.delete(assetId);
        return cached;
      }

      if (!audioContextRef.current) return null;

      const failedInfo = failedLoadsRef.current.get(assetId);
      if (failedInfo && failedInfo.attemptCount >= MAX_RETRY_ATTEMPTS && !isRetry) {
        logger.debug('Skipping load - max retry attempts reached', { assetId });
        return null;
      }

      try {
        let url = assetUri;
        if (url.startsWith('file://')) {
          url = convertFileSrc(url.replace('file://', ''));
        } else if (url.startsWith('/') || url.match(/^[A-Za-z]:\\/)) {
          url = convertFileSrc(url);
        }

        logger.debug('Loading audio buffer', { assetId, isRetry });

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);

        audioBuffersRef.current.set(assetId, audioBuffer);
        failedLoadsRef.current.delete(assetId);

        logger.debug('Audio buffer loaded successfully', { assetId });
        return audioBuffer;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const currentAttempt = (failedInfo?.attemptCount ?? 0) + 1;

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

        if (currentAttempt < MAX_RETRY_ATTEMPTS) {
          const retryDelay = getRetryDelay(currentAttempt);
          logger.debug('Scheduling audio load retry', {
            assetId,
            retryDelay,
            attempt: currentAttempt,
          });

          const existingTimeout = retryTimeoutsRef.current.get(assetId);
          if (existingTimeout) {
            clearTimeout(existingTimeout);
          }

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

  // -------------------------------------------------------------------------
  // Retry Load
  // -------------------------------------------------------------------------

  const retryLoad = useCallback(
    async (assetId: string): Promise<boolean> => {
      const asset = assets.get(assetId);
      if (!asset) {
        logger.warn('Cannot retry load: asset not found', { assetId });
        return false;
      }

      failedLoadsRef.current.delete(assetId);

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

  // -------------------------------------------------------------------------
  // Create Effect Chain for Clip
  // -------------------------------------------------------------------------

  const createEffectChainForClip = useCallback(
    (clip: Clip, audioContext: AudioContext): AudioEffectNode[] => {
      if (!getEffectById || clip.effects.length === 0) {
        return [];
      }

      const effectNodes: AudioEffectNode[] = [];

      // Sort effects by order and create nodes
      const sortedEffectIds = [...clip.effects];
      const effectsWithOrder = sortedEffectIds
        .map((id) => {
          const effect = getEffectById(id);
          return effect ? { id, effect } : null;
        })
        .filter((e): e is { id: string; effect: Effect } => e !== null)
        .filter((e) => isAudioEffect(toEffectTypeId(e.effect.effectType)))
        .sort((a, b) => a.effect.order - b.effect.order);

      for (const { effect } of effectsWithOrder) {
        const config: EffectNodeConfig = {
          effectType: toEffectTypeId(effect.effectType),
          params: extractNumericParams(effect.params),
          enabled: effect.enabled,
        };

        const effectNode = createAudioEffectNode(audioContext, config);
        if (effectNode) {
          effectNodes.push(effectNode);
        }
      }

      // Connect effect nodes in chain
      for (let i = 0; i < effectNodes.length - 1; i++) {
        effectNodes[i].node.connect(effectNodes[i + 1].node);
      }

      return effectNodes;
    },
    [getEffectById],
  );

  // -------------------------------------------------------------------------
  // Get Audio Clips
  // -------------------------------------------------------------------------

  const getAudioClips = useCallback((): Array<{
    clip: Clip;
    asset: Asset;
    trackVolume: number;
    trackMuted: boolean;
  }> => {
    return collectPlaybackAudioClips(sequence, assets);
  }, [sequence, assets]);

  // -------------------------------------------------------------------------
  // Stop All Sources
  // -------------------------------------------------------------------------

  const stopAllSources = useCallback(() => {
    scheduleVersionRef.current += 1;
    rescheduleRequestedRef.current = false;

    scheduledSourcesRef.current.forEach((scheduled) => {
      try {
        scheduled.source.stop();
        scheduled.source.disconnect();
        scheduled.gainNode.disconnect();
        scheduled.pannerNode.disconnect();

        // Disconnect effect nodes
        for (const effectNode of scheduled.effectNodes) {
          try {
            effectNode.node.disconnect();
          } catch {
            // Already disconnected
          }
        }
      } catch {
        // Already stopped
      }
    });
    scheduledSourcesRef.current.clear();
  }, []);

  // -------------------------------------------------------------------------
  // Calculate Clip Volume
  // -------------------------------------------------------------------------

  const calculateClipVolume = useCallback((clip: Clip, trackVolume: number): number => {
    if (clip.audio?.muted) return 0;

    const clipVolumeDb = clampClipVolumeDb(clip.audio?.volumeDb ?? 0);
    const clipLinearVolume = Math.pow(10, clipVolumeDb / 20);

    return trackVolume * clipLinearVolume;
  }, []);

  // -------------------------------------------------------------------------
  // Schedule Audio Clips
  // -------------------------------------------------------------------------

  const scheduleAudioClips = useCallback(async () => {
    if (!audioContextRef.current || !masterGainRef.current || !enabled) return;
    if (!isPlaying || !getLiveIsPlaying()) return;

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

        if (now - lastScheduleTimeRef.current < RESCHEDULE_INTERVAL) {
          continue;
        }
        lastScheduleTimeRef.current = now;

        const audioClips = getAudioClips();

        for (const { clip, asset, trackVolume, trackMuted } of audioClips) {
          if (trackMuted) continue;

          const safeSpeed = clip.speed > 0 ? clip.speed : 1;
          const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
          const clipEnd = clip.place.timelineInSec + clipDuration;

          if (currentTime >= clipEnd) continue;
          if (clip.place.timelineInSec > currentTime + SCHEDULE_AHEAD_TIME) continue;
          if (scheduledSourcesRef.current.has(clip.id)) continue;

          const audioUrl = asset.proxyUrl || asset.uri;
          const audioBuffer = await loadAudioBuffer(asset.id, audioUrl);
          if (!audioBuffer) continue;

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

          if (scheduledSourcesRef.current.has(clip.id)) {
            continue;
          }

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.playbackRate.value = playbackRate * safeSpeed;

          const gainNode = ctx.createGain();
          const clipVolume = calculateClipVolume(clip, trackVolume);
          const clipOffset = Math.max(0, currentTime - clip.place.timelineInSec);
          const fadeFactor = getClipFadeFactor(clip, clipOffset);
          gainNode.gain.value = (isMuted ? 0 : volume * clipVolume) * fadeFactor;

          const pannerNode = ctx.createStereoPanner();
          pannerNode.pan.value = clampClipPan(clip.audio?.pan ?? 0);

          const effectNodes = createEffectChainForClip(clip, ctx);

          source.connect(gainNode);
          gainNode.connect(pannerNode);

          if (effectNodes.length > 0) {
            pannerNode.connect(effectNodes[0].node);
            effectNodes[effectNodes.length - 1].node.connect(masterGainRef.current);
          } else {
            pannerNode.connect(masterGainRef.current);
          }

          const timeIntoClip = Math.max(0, currentTime - clip.place.timelineInSec);
          const sourceOffset = clip.range.sourceInSec + timeIntoClip * safeSpeed;
          const startDelay = Math.max(0, clip.place.timelineInSec - currentTime);
          const remainingSourceDuration = clip.range.sourceOutSec - sourceOffset;
          const audioDuration = Math.max(0, remainingSourceDuration);

          const scheduledStartTime = now + startDelay;
          source.start(scheduledStartTime, sourceOffset, audioDuration);

          scheduledSourcesRef.current.set(clip.id, {
            source,
            gainNode,
            pannerNode,
            effectNodes,
            clipId: clip.id,
            startTime: scheduledStartTime,
          });

          source.onended = () => {
            const active = scheduledSourcesRef.current.get(clip.id);
            if (active?.source === source) {
              scheduledSourcesRef.current.delete(clip.id);
            }
            source.disconnect();
            gainNode.disconnect();
            pannerNode.disconnect();
            for (const effectNode of effectNodes) {
              try {
                effectNode.node.disconnect();
              } catch {
                // Already disconnected
              }
            }
          };
        }

        if (scheduleVersion !== scheduleVersionRef.current) {
          rescheduleRequestedRef.current = enabled && getLiveIsPlaying();
          continue;
        }

        scheduledSourcesRef.current.forEach((scheduled) => {
          const clipData = audioClips.find((c) => c.clip.id === scheduled.clipId);
          if (clipData) {
            const clipVolume = calculateClipVolume(clipData.clip, clipData.trackVolume);
            const clipOffset = Math.max(0, currentTime - clipData.clip.place.timelineInSec);
            const fadeFactor = getClipFadeFactor(clipData.clip, clipOffset);
            scheduled.gainNode.gain.value = (isMuted ? 0 : volume * clipVolume) * fadeFactor;
            scheduled.pannerNode.pan.value = clampClipPan(clipData.clip.audio?.pan ?? 0);
            const updateSpeed = clipData.clip.speed > 0 ? clipData.clip.speed : 1;
            scheduled.source.playbackRate.value = playbackRate * updateSpeed;
          }
        });
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
    createEffectChainForClip,
    getLiveIsPlaying,
  ]);

  // -------------------------------------------------------------------------
  // Update Clip Effect
  // -------------------------------------------------------------------------

  const updateClipEffect = useCallback(
    (clipId: string, effectId: string, paramName: string, value: number) => {
      const scheduled = scheduledSourcesRef.current.get(clipId);
      if (!scheduled || !getEffectById) return;

      const effect = getEffectById(effectId);
      if (!effect) return;

      // Find the effect node for this effect
      const effectTypeId = toEffectTypeId(effect.effectType);
      const effectNode = scheduled.effectNodes.find((node) => node.effectType === effectTypeId);

      if (effectNode) {
        updateAudioEffectNode(effectNode, { [paramName]: value });
      }
    },
    [getEffectById],
  );

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  // Clean up retry timeouts when disabled
  useEffect(() => {
    if (!enabled) {
      stopAllSources();
      for (const timeoutId of retryTimeoutsRef.current.values()) {
        clearTimeout(timeoutId);
      }
      retryTimeoutsRef.current.clear();
    }
  }, [enabled, stopAllSources]);

  // Handle play/pause
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    if (isPlaying) {
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

  // Handle seek
  const lastSeekTimeRef = useRef(currentTime);
  const lastSeekTimestampRef = useRef(Date.now());
  useEffect(() => {
    if (!enabled) return;

    const now = Date.now();
    const previousTime = lastSeekTimeRef.current;
    const previousTimestamp = lastSeekTimestampRef.current;
    const timeDiff = Math.abs(currentTime - previousTime);
    const timestampDiff = (now - previousTimestamp) / 1000;

    lastSeekTimeRef.current = currentTime;
    lastSeekTimestampRef.current = now;

    if (timeDiff < SEEK_DETECTION_DELTA_THRESHOLD || timestampDiff <= 0) return;

    if (!isPlaying) return;

    const expectedDelta = Math.abs(playbackRate) * timestampDiff;
    const tolerance = Math.max(PLAYBACK_PROGRESS_TOLERANCE, expectedDelta * 0.35);
    const isLikelyNaturalPlayback = timeDiff <= expectedDelta + tolerance;

    if (isLikelyNaturalPlayback) return;

    stopAllSources();

    lastScheduleTimeRef.current = 0;
    void scheduleAudioClips();
  }, [enabled, currentTime, isPlaying, playbackRate, stopAllSources, scheduleAudioClips]);

  // Master gain kept at unity — global volume/mute is already applied per-clip
  useEffect(() => {
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = 1;
    }
  }, [volume, isMuted]);

  // Cleanup on unmount
  useEffect(() => {
    const audioBuffers = audioBuffersRef.current;
    const retryTimeouts = retryTimeoutsRef.current;
    const failedLoads = failedLoadsRef.current;

    return () => {
      stopAllSources();

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
      setIsAudioReady(false);
    };
  }, [stopAllSources]);

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    initAudio,
    isAudioReady,
    retryLoad,
    failedAssets: Array.from(failedLoadsRef.current.keys()),
    updateClipEffect,
  };
}

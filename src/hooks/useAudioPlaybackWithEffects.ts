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
  updateClipEffect: (
    clipId: string,
    effectId: string,
    paramName: string,
    value: number
  ) => void;
}

interface ScheduledSource {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
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
function extractNumericParams(
  params: Record<string, unknown>
): Record<string, number> {
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
  const masterGainRef = useRef<GainNode | null>(null);
  const [isAudioReady, setIsAudioReady] = useState(false);
  const lastScheduleTimeRef = useRef(0);

  // Failed loads tracking
  const failedLoadsRef = useRef<Map<string, FailedLoadInfo>>(new Map());
  const retryTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Playback state
  const { currentTime, isPlaying, volume, isMuted, playbackRate } = usePlaybackStore();

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
          logger.debug('Scheduling audio load retry', { assetId, retryDelay, attempt: currentAttempt });

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
    [getRetryDelay]
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
    [assets, loadAudioBuffer]
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
    [getEffectById]
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
    if (!sequence) return [];

    const audioClips: Array<{
      clip: Clip;
      asset: Asset;
      trackVolume: number;
      trackMuted: boolean;
    }> = [];

    for (const track of sequence.tracks) {
      if (track.muted) continue;

      for (const clip of track.clips) {
        const asset = assets.get(clip.assetId);
        if (!asset) continue;

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

  // -------------------------------------------------------------------------
  // Stop All Sources
  // -------------------------------------------------------------------------

  const stopAllSources = useCallback(() => {
    scheduledSourcesRef.current.forEach((scheduled) => {
      try {
        scheduled.source.stop();
        scheduled.source.disconnect();
        scheduled.gainNode.disconnect();

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

    const clipVolumeDb = clip.audio?.volumeDb ?? 0;
    const clipLinearVolume = Math.pow(10, clipVolumeDb / 20);

    return trackVolume * clipLinearVolume;
  }, []);

  // -------------------------------------------------------------------------
  // Schedule Audio Clips
  // -------------------------------------------------------------------------

  const scheduleAudioClips = useCallback(async () => {
    if (!audioContextRef.current || !masterGainRef.current || !enabled) return;
    if (!isPlaying) return;

    const ctx = audioContextRef.current;
    const now = ctx.currentTime;

    if (now - lastScheduleTimeRef.current < RESCHEDULE_INTERVAL) return;
    lastScheduleTimeRef.current = now;

    const audioClips = getAudioClips();

    for (const { clip, asset, trackVolume, trackMuted } of audioClips) {
      if (trackMuted) continue;

      const clipDuration = (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
      const clipEnd = clip.place.timelineInSec + clipDuration;

      if (currentTime >= clipEnd) continue;
      if (clip.place.timelineInSec > currentTime + SCHEDULE_AHEAD_TIME) continue;
      if (scheduledSourcesRef.current.has(clip.id)) continue;

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

      // Create effect chain for this clip
      const effectNodes = createEffectChainForClip(clip, ctx);

      // Connect the audio graph:
      // source -> gainNode -> [effectChain] -> masterGain
      source.connect(gainNode);

      if (effectNodes.length > 0) {
        gainNode.connect(effectNodes[0].node);
        effectNodes[effectNodes.length - 1].node.connect(masterGainRef.current);
      } else {
        gainNode.connect(masterGainRef.current);
      }

      // Calculate timing
      const timeIntoClip = Math.max(0, currentTime - clip.place.timelineInSec);
      const sourceOffset = clip.range.sourceInSec + timeIntoClip * clip.speed;
      const startDelay = Math.max(0, clip.place.timelineInSec - currentTime);
      const remainingSourceDuration = clip.range.sourceOutSec - sourceOffset;
      const audioDuration = Math.max(0, remainingSourceDuration);

      const scheduledStartTime = now + startDelay;
      source.start(scheduledStartTime, sourceOffset, audioDuration);

      // Track the scheduled source with effect nodes
      scheduledSourcesRef.current.set(clip.id, {
        source,
        gainNode,
        effectNodes,
        clipId: clip.id,
        startTime: scheduledStartTime,
      });

      // Clean up when source ends
      source.onended = () => {
        const scheduled = scheduledSourcesRef.current.get(clip.id);
        if (scheduled) {
          scheduled.source.disconnect();
          scheduled.gainNode.disconnect();
          for (const effectNode of scheduled.effectNodes) {
            try {
              effectNode.node.disconnect();
            } catch {
              // Already disconnected
            }
          }
        }
        scheduledSourcesRef.current.delete(clip.id);
      };
    }

    // Update volume and playback rate on existing sources
    scheduledSourcesRef.current.forEach((scheduled) => {
      const clipData = audioClips.find((c) => c.clip.id === scheduled.clipId);
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
    createEffectChainForClip,
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
      const effectNode = scheduled.effectNodes.find(
        (node) => node.effectType === effectTypeId
      );

      if (effectNode) {
        updateAudioEffectNode(effectNode, { [paramName]: value });
      }
    },
    [getEffectById]
  );

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

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
  useEffect(() => {
    if (!enabled) return;

    const timeDiff = Math.abs(currentTime - lastSeekTimeRef.current);
    if (timeDiff < 0.1) return;
    lastSeekTimeRef.current = currentTime;

    stopAllSources();

    if (isPlaying) {
      lastScheduleTimeRef.current = 0;
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

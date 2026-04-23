/**
 * useAudioScrubbing Hook
 *
 * Plays short audio snippets during playhead scrubbing and dragging.
 * Automatically detects scrubbing by monitoring seek events while playback
 * is paused. Respects the audioScrubbing setting from settingsStore.
 *
 * Design:
 * - Self-contained: manages its own AudioContext and buffer cache
 * - Reactive: responds to playbackStore.currentTime changes while paused
 * - Throttled: prevents audio flooding during rapid scrubbing
 * - Fade envelope: short fade in/out prevents click artifacts
 */

import { useRef, useEffect, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useAudioMixerStore } from '@/stores/audioMixerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { collectPlaybackAudioClips } from '@/utils/audioPlayback';
import { clampClipVolumeDb, clampClipPan } from '@/utils/clipAudio';
import {
  connectSourceToDestination,
  resolveMasterOutputGain,
  resolveTrackPlaybackRouting,
} from '@/utils/audioRouting';
import {
  assetMatchesWorkspaceRelativePath,
  clearCachedAudioPreview,
  decodeAssetAudioBuffer,
} from '@/utils/audioPreview';
import type { Sequence, Asset } from '@/types';
import { getClipSourceTimeAtTimelineTime, getClipTimelineEndSec } from '@/utils/clipTiming';

// =============================================================================
// Constants
// =============================================================================

/** Duration of each audio scrub snippet in seconds */
export const SCRUB_SNIPPET_DURATION_SEC = 0.08;

/** Minimum interval between scrub snippets in ms */
export const SCRUB_THROTTLE_MS = 50;

/** Minimum time change in seconds to trigger a new snippet */
const SCRUB_MIN_SEEK_DELTA = 0.001;

/** Fade duration in seconds to prevent click artifacts */
const SNIPPET_FADE_SEC = 0.005;

// =============================================================================
// Types
// =============================================================================

export interface UseAudioScrubbingOptions {
  /** Sequence containing audio clips */
  sequence: Sequence | null;
  /** Assets map for looking up audio sources */
  assets: Map<string, Asset>;
  /** Whether scrubbing audio is allowed to initialize */
  enabled?: boolean;
}

interface ActiveSnippet {
  source: AudioBufferSourceNode;
  clipGainNode: GainNode;
  clipPannerNode: StereoPannerNode;
  trackGainNode: GainNode;
  trackPannerNode: StereoPannerNode;
  masterGainNode: GainNode;
}

// =============================================================================
// Hook
// =============================================================================

export function useAudioScrubbing({
  sequence,
  assets,
  enabled = true,
}: UseAudioScrubbingOptions): void {
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const activeSnippetsRef = useRef<ActiveSnippet[]>([]);
  const lastScrubTimestampRef = useRef<number>(0);
  const prevTimeRef = useRef<number>(-1);
  const scrubRequestIdRef = useRef<number>(0);

  const audioScrubbing = useSettingsStore((state) => state.settings.playback.audioScrubbing);

  const currentTime = usePlaybackStore((s) => s.currentTime);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const volume = usePlaybackStore((s) => s.volume);
  const isMuted = usePlaybackStore((s) => s.isMuted);

  /**
   * Get or create AudioContext lazily.
   * Returns null if creation fails (e.g., browser restrictions).
   */
  const getAudioContext = useCallback((): AudioContext | null => {
    if (!enabled) {
      return null;
    }

    if (!audioContextRef.current) {
      try {
        audioContextRef.current = new AudioContext();
      } catch {
        return null;
      }
    }

    if (audioContextRef.current.state === 'suspended') {
      try {
        audioContextRef.current.resume()?.catch?.(() => {});
      } catch {
        // Resume failure is non-fatal
      }
    }

    return audioContextRef.current;
  }, [enabled]);

  /**
   * Load and cache an audio buffer for an asset.
   * Uses the same URL resolution logic as useAudioPlayback.
   */
  const loadBuffer = useCallback(
    async (asset: Asset): Promise<AudioBuffer | null> => {
      const cached = audioBuffersRef.current.get(asset.id);
      if (cached) return cached;

      const ctx = getAudioContext();
      if (!ctx) return null;

      try {
        const { buffer: audioBuffer } = await decodeAssetAudioBuffer(ctx, asset);
        audioBuffersRef.current.set(asset.id, audioBuffer);
        return audioBuffer;
      } catch {
        return null;
      }
    },
    [getAudioContext],
  );

  /**
   * Stop all currently playing scrub snippets.
   */
  const stopSnippets = useCallback(() => {
    // Invalidate any in-flight async scrub requests
    scrubRequestIdRef.current += 1;
    for (const snippet of activeSnippetsRef.current) {
      try {
        snippet.source.stop();
        snippet.source.disconnect();
        snippet.clipGainNode.disconnect();
        snippet.clipPannerNode.disconnect();
        snippet.trackGainNode.disconnect();
        snippet.trackPannerNode.disconnect();
        snippet.masterGainNode.disconnect();
      } catch {
        // Already stopped or disconnected
      }
    }
    activeSnippetsRef.current = [];
  }, []);

  /**
   * Play short audio snippets at the given timeline time.
   * All audio clips active at the position are mixed for accurate preview.
   */
  const playScrubSnippet = useCallback(
    async (time: number) => {
      const ctx = getAudioContext();
      if (!ctx || !sequence) return;

      // Stop previous snippets before starting new ones
      stopSnippets();

      // Capture current request ID to detect stale continuations
      const requestId = scrubRequestIdRef.current;

      const audioClips = collectPlaybackAudioClips(sequence, assets);
      const { trackStates, soloedTrackIds, masterState } = useAudioMixerStore.getState();
      const masterVolume = resolveMasterOutputGain(volume, isMuted, masterState);

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

        const safeSpeed = clip.speed > 0 ? clip.speed : 1;
        const clipEnd = getClipTimelineEndSec(clip);

        // Skip clips that don't overlap with the scrub position
        if (time < clip.place.timelineInSec || time >= clipEnd) continue;

        // Calculate the source offset corresponding to timeline time
        const sourceOffset = getClipSourceTimeAtTimelineTime(clip, time);

        const buffer = await loadBuffer(asset);
        // Bail if a newer request has superseded this one
        if (scrubRequestIdRef.current !== requestId) return;
        if (!buffer || sourceOffset >= buffer.duration) continue;

        // Create source node
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = safeSpeed;

        // Calculate combined volume: master * track * clip
        const clipVolumeDb = clampClipVolumeDb(clip.audio?.volumeDb ?? 0);
        const clipLinearVolume = Math.pow(10, clipVolumeDb / 20);
        const clipMuted = clip.audio?.muted ?? false;
        const clipVolume = clipMuted ? 0 : clipLinearVolume;
        const finalVolume = masterVolume * trackRouting.trackGain * clipVolume;

        // Create gain node with fade envelope to prevent click artifacts
        const clipGainNode = ctx.createGain();
        const now = ctx.currentTime;
        clipGainNode.gain.setValueAtTime(0, now);
        clipGainNode.gain.linearRampToValueAtTime(finalVolume, now + SNIPPET_FADE_SEC);
        const sustainEnd = now + SCRUB_SNIPPET_DURATION_SEC - SNIPPET_FADE_SEC;
        if (sustainEnd > now + SNIPPET_FADE_SEC) {
          clipGainNode.gain.setValueAtTime(finalVolume, sustainEnd);
        }
        clipGainNode.gain.linearRampToValueAtTime(0, now + SCRUB_SNIPPET_DURATION_SEC);

        // Build a short-lived chain that mirrors clip -> track -> master routing.
        const clipPannerNode = ctx.createStereoPanner();
        clipPannerNode.pan.value = clampClipPan(clip.audio?.pan ?? 0);
        const trackGainNode = ctx.createGain();
        trackGainNode.gain.value = 1;
        const trackPannerNode = ctx.createStereoPanner();
        trackPannerNode.pan.value = trackRouting.trackPan;
        const masterGainNode = ctx.createGain();
        masterGainNode.gain.value = 1;

        connectSourceToDestination(source, clipGainNode, clipPannerNode, trackGainNode);
        trackGainNode.connect(trackPannerNode);
        trackPannerNode.connect(masterGainNode);
        masterGainNode.connect(ctx.destination);

        // Calculate available source duration (capped by buffer end)
        const availableDuration = Math.min(
          SCRUB_SNIPPET_DURATION_SEC / safeSpeed,
          buffer.duration - sourceOffset,
        );
        if (availableDuration <= 0) continue;

        source.start(0, sourceOffset, availableDuration);

        const snippet: ActiveSnippet = {
          source,
          clipGainNode,
          clipPannerNode,
          trackGainNode,
          trackPannerNode,
          masterGainNode,
        };
        activeSnippetsRef.current.push(snippet);

        // Auto-cleanup when snippet finishes
        source.onended = () => {
          const idx = activeSnippetsRef.current.indexOf(snippet);
          if (idx !== -1) {
            activeSnippetsRef.current.splice(idx, 1);
          }
          source.disconnect();
          clipGainNode.disconnect();
          clipPannerNode.disconnect();
          trackGainNode.disconnect();
          trackPannerNode.disconnect();
          masterGainNode.disconnect();
        };
      }
    },
    [getAudioContext, sequence, assets, loadBuffer, stopSnippets, volume, isMuted],
  );

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
      }

      stopSnippets();
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
  }, [assets, stopSnippets]);

  // Main effect: detect scrubbing and play audio snippets.
  // Scrubbing = currentTime changing while playback is paused.
  useEffect(() => {
    // Don't scrub when disabled or during normal playback
    if (!enabled || !audioScrubbing || isPlaying) {
      prevTimeRef.current = currentTime;
      return;
    }

    // Skip initial mount to avoid spurious snippet on first render
    if (prevTimeRef.current < 0) {
      prevTimeRef.current = currentTime;
      return;
    }

    // Only trigger on meaningful time changes
    const timeDelta = Math.abs(currentTime - prevTimeRef.current);
    if (timeDelta < SCRUB_MIN_SEEK_DELTA) return;

    prevTimeRef.current = currentTime;

    // Throttle: skip if called too soon after previous snippet
    const now = Date.now();
    if (now - lastScrubTimestampRef.current < SCRUB_THROTTLE_MS) return;
    lastScrubTimestampRef.current = now;

    void playScrubSnippet(currentTime);
  }, [currentTime, enabled, isPlaying, audioScrubbing, playScrubSnippet]);

  // Stop snippets when playback resumes (scrubbing ended)
  useEffect(() => {
    if (!enabled) {
      stopSnippets();
    }
  }, [enabled, stopSnippets]);

  useEffect(() => {
    if (isPlaying) {
      stopSnippets();
    }
  }, [isPlaying, stopSnippets]);

  // Cleanup on unmount
  useEffect(() => {
    const buffers = audioBuffersRef.current;
    return () => {
      stopSnippets();
      if (audioContextRef.current) {
        try {
          audioContextRef.current.close()?.catch?.(() => {});
        } catch {
          // Close failure during cleanup is non-fatal
        }
        audioContextRef.current = null;
      }
      buffers.clear();
    };
  }, [stopSnippets]);
}

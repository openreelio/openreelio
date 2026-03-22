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
import { convertFileSrc } from '@tauri-apps/api/core';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { collectPlaybackAudioClips } from '@/utils/audioPlayback';
import { clampClipVolumeDb, clampClipPan } from '@/utils/clipAudio';
import { normalizeFileUriToPath } from '@/utils/uri';
import type { Sequence, Asset } from '@/types';

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
}

interface ActiveSnippet {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  pannerNode: StereoPannerNode;
}

// =============================================================================
// Hook
// =============================================================================

export function useAudioScrubbing({
  sequence,
  assets,
}: UseAudioScrubbingOptions): void {
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBuffersRef = useRef<Map<string, AudioBuffer>>(new Map());
  const activeSnippetsRef = useRef<ActiveSnippet[]>([]);
  const lastScrubTimestampRef = useRef<number>(0);
  const prevTimeRef = useRef<number>(-1);

  const audioScrubbing = useSettingsStore(
    (state) => state.settings.playback.audioScrubbing,
  );

  const currentTime = usePlaybackStore((s) => s.currentTime);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const volume = usePlaybackStore((s) => s.volume);
  const isMuted = usePlaybackStore((s) => s.isMuted);

  /**
   * Get or create AudioContext lazily.
   * Returns null if creation fails (e.g., browser restrictions).
   */
  const getAudioContext = useCallback((): AudioContext | null => {
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
  }, []);

  /**
   * Load and cache an audio buffer for an asset.
   * Uses the same URL resolution logic as useAudioPlayback.
   */
  const loadBuffer = useCallback(
    async (assetId: string, assetUri: string): Promise<AudioBuffer | null> => {
      const cached = audioBuffersRef.current.get(assetId);
      if (cached) return cached;

      const ctx = getAudioContext();
      if (!ctx) return null;

      try {
        let url = normalizeFileUriToPath(assetUri.trim());
        if (
          !url.startsWith('asset://') &&
          (url.startsWith('/') || url.match(/^[A-Za-z]:[\\/]/))
        ) {
          url = convertFileSrc(url);
        }

        const response = await fetch(url);
        if (!response.ok) return null;

        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        audioBuffersRef.current.set(assetId, audioBuffer);
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
    for (const snippet of activeSnippetsRef.current) {
      try {
        snippet.source.stop();
        snippet.source.disconnect();
        snippet.gainNode.disconnect();
        snippet.pannerNode.disconnect();
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

      const audioClips = collectPlaybackAudioClips(sequence, assets);
      const masterVolume = isMuted ? 0 : volume;

      for (const { clip, asset, trackVolume } of audioClips) {
        const safeSpeed = clip.speed > 0 ? clip.speed : 1;
        const clipDuration =
          (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
        const clipEnd = clip.place.timelineInSec + clipDuration;

        // Skip clips that don't overlap with the scrub position
        if (time < clip.place.timelineInSec || time >= clipEnd) continue;

        // Calculate the source offset corresponding to timeline time
        const timeIntoClip = time - clip.place.timelineInSec;
        const sourceOffset = clip.range.sourceInSec + timeIntoClip * safeSpeed;

        const buffer = await loadBuffer(asset.id, asset.uri);
        if (!buffer || sourceOffset >= buffer.duration) continue;

        // Create source node
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = safeSpeed;

        // Calculate combined volume: master * track * clip
        const clipVolumeDb = clampClipVolumeDb(clip.audio?.volumeDb ?? 0);
        const clipLinearVolume = Math.pow(10, clipVolumeDb / 20);
        const clipMuted = clip.audio?.muted ?? false;
        const clipVolume = clipMuted ? 0 : trackVolume * clipLinearVolume;
        const finalVolume = masterVolume * clipVolume;

        // Create gain node with fade envelope to prevent click artifacts
        const gainNode = ctx.createGain();
        const now = ctx.currentTime;
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(finalVolume, now + SNIPPET_FADE_SEC);
        const sustainEnd = now + SCRUB_SNIPPET_DURATION_SEC - SNIPPET_FADE_SEC;
        if (sustainEnd > now + SNIPPET_FADE_SEC) {
          gainNode.gain.setValueAtTime(finalVolume, sustainEnd);
        }
        gainNode.gain.linearRampToValueAtTime(0, now + SCRUB_SNIPPET_DURATION_SEC);

        // Create panner node
        const pannerNode = ctx.createStereoPanner();
        pannerNode.pan.value = clampClipPan(clip.audio?.pan ?? 0);

        // Connect: source -> gain -> panner -> destination
        source.connect(gainNode);
        gainNode.connect(pannerNode);
        pannerNode.connect(ctx.destination);

        // Calculate available source duration (capped by buffer end)
        const availableDuration = Math.min(
          SCRUB_SNIPPET_DURATION_SEC / safeSpeed,
          buffer.duration - sourceOffset,
        );
        if (availableDuration <= 0) continue;

        source.start(0, sourceOffset, availableDuration);

        const snippet: ActiveSnippet = { source, gainNode, pannerNode };
        activeSnippetsRef.current.push(snippet);

        // Auto-cleanup when snippet finishes
        source.onended = () => {
          const idx = activeSnippetsRef.current.indexOf(snippet);
          if (idx !== -1) {
            activeSnippetsRef.current.splice(idx, 1);
          }
          source.disconnect();
          gainNode.disconnect();
          pannerNode.disconnect();
        };
      }
    },
    [getAudioContext, sequence, assets, loadBuffer, stopSnippets, volume, isMuted],
  );

  // Main effect: detect scrubbing and play audio snippets.
  // Scrubbing = currentTime changing while playback is paused.
  useEffect(() => {
    // Don't scrub when disabled or during normal playback
    if (!audioScrubbing || isPlaying) {
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
  }, [currentTime, isPlaying, audioScrubbing, playScrubSnippet]);

  // Stop snippets when playback resumes (scrubbing ended)
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

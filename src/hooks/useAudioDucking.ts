/**
 * useAudioDucking Hook
 *
 * Provides a function to apply audio ducking to a music clip based on
 * speech detected on a dialogue track. Uses the backend `apply_audio_ducking`
 * IPC command which analyzes clip positions and generates volume keyframes.
 */

import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AudioDuckingParams } from '@/types';
import { useProjectStore } from '@/stores/projectStore';
import { commandQueue } from '@/utils/commandQueue';
import { requestDeduplicator } from '@/utils/requestDeduplicator';
import { applyProjectState, refreshProjectState } from '@/utils/stateRefreshHelper';

/** Default ducking parameters */
export const DEFAULT_DUCKING_PARAMS: AudioDuckingParams = {
  thresholdDb: -30,
  duckAmountDb: -15,
  attackMs: 200,
  releaseMs: 500,
};

/** Preset ducking configurations */
export const DUCKING_PRESETS = {
  gentle: {
    label: 'Gentle',
    params: { thresholdDb: -30, duckAmountDb: -8, attackMs: 300, releaseMs: 600 },
  },
  standard: {
    label: 'Standard',
    params: { thresholdDb: -30, duckAmountDb: -15, attackMs: 200, releaseMs: 500 },
  },
  aggressive: {
    label: 'Aggressive',
    params: { thresholdDb: -25, duckAmountDb: -24, attackMs: 100, releaseMs: 400 },
  },
} as const;

export type DuckingPresetKey = keyof typeof DUCKING_PRESETS;

interface ApplyDuckingResult {
  opId: string;
  createdIds: string[];
  deletedIds: string[];
}

interface UseAudioDuckingReturn {
  /** Apply ducking to a music clip based on speech track clips */
  applyDucking: (
    sequenceId: string,
    speechTrackId: string,
    musicTrackId: string,
    musicClipId: string,
    params?: AudioDuckingParams,
  ) => Promise<ApplyDuckingResult>;
  /** Whether a ducking operation is in progress */
  isApplying: boolean;
  /** Error message from the last failed operation */
  error: string | null;
}

export function useAudioDucking(): UseAudioDuckingReturn {
  const pendingCountRef = useRef(0);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyDucking = useCallback(
    async (
      sequenceId: string,
      speechTrackId: string,
      musicTrackId: string,
      musicClipId: string,
      params: AudioDuckingParams = DEFAULT_DUCKING_PARAMS,
    ): Promise<ApplyDuckingResult> => {
      pendingCountRef.current += 1;
      setIsApplying(true);
      setError(null);

      const payload = {
        sequenceId,
        speechTrackId,
        musicTrackId,
        musicClipId,
        params,
      };

      try {
        const result = await requestDeduplicator.execute(
          'apply_audio_ducking',
          payload,
          () =>
            commandQueue.enqueue(async () => {
              const versionBefore = useProjectStore.getState().stateVersion;

              const commandResult = await invoke<ApplyDuckingResult>('apply_audio_ducking', {
                args: payload,
              });
              const freshState = await refreshProjectState();

              let concurrentModificationDetected = false;
              useProjectStore.setState((state) => {
                if (state.stateVersion !== versionBefore) {
                  concurrentModificationDetected = true;
                  return;
                }

                state.isDirty = true;
                state.stateVersion += 1;
                state.error = null;
                applyProjectState(state, freshState);
              });

              if (concurrentModificationDetected) {
                throw new Error(
                  'Concurrent modification detected during audio ducking. Please retry.',
                );
              }

              return commandResult;
            }, 'applyAudioDucking'),
        );

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        useProjectStore.setState((state) => {
          state.error = message;
        });
        throw err;
      } finally {
        pendingCountRef.current -= 1;
        if (pendingCountRef.current <= 0) {
          pendingCountRef.current = 0;
          setIsApplying(false);
        }
      }
    },
    [],
  );

  return { applyDucking, isApplying, error };
}

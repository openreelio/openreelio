/**
 * Hook for effect preset CRUD operations via IPC.
 *
 * Provides functions to save, load, list, and delete effect presets.
 * Manages local cache of preset summaries for responsive UI.
 */
import { useCallback, useEffect, useState } from 'react';

import { invoke } from '@tauri-apps/api/core';

import type {
  EffectPreset,
  EffectPresetSummary,
  EffectType,
  Keyframe,
  SimpleParamValue,
} from '@/types';

interface UseEffectPresetsReturn {
  /** Cached list of preset summaries */
  presets: EffectPresetSummary[];
  /** Whether initial load is in progress */
  loading: boolean;
  /** Last error message, if any */
  error: string | null;
  /** Refresh presets list from backend */
  refreshPresets: () => Promise<void>;
  /** Save current effect params as a new preset */
  savePreset: (
    name: string,
    description: string | undefined,
    effectType: EffectType,
    params: Record<string, SimpleParamValue>,
    keyframes?: Record<string, Keyframe[]>,
  ) => Promise<EffectPreset>;
  /** Load full preset data by ID */
  loadPreset: (presetId: string) => Promise<EffectPreset>;
  /** Delete a preset by ID */
  deletePreset: (presetId: string) => Promise<void>;
}

interface UseEffectPresetsOptions {
  autoLoad?: boolean;
}

export function useEffectPresets(options: UseEffectPresetsOptions = {}): UseEffectPresetsReturn {
  const { autoLoad = true } = options;
  const [presets, setPresets] = useState<EffectPresetSummary[]>([]);
  const [loading, setLoading] = useState(autoLoad);
  const [error, setError] = useState<string | null>(null);

  const refreshPresets = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await invoke<EffectPresetSummary[]>('list_effect_presets');
      setPresets(result);
    } catch (errorValue) {
      const msg = errorValue instanceof Error ? errorValue.message : String(errorValue);
      setError(msg);
      throw errorValue;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!autoLoad) {
      setLoading(false);
      return;
    }

    void refreshPresets().catch(() => undefined);
  }, [autoLoad, refreshPresets]);

  const savePreset = useCallback(
    async (
      name: string,
      description: string | undefined,
      effectType: EffectType,
      params: Record<string, SimpleParamValue>,
      keyframes?: Record<string, Keyframe[]>,
    ): Promise<EffectPreset> => {
      try {
        setError(null);
        const result = await invoke<EffectPreset>('save_effect_preset', {
          name,
          description: description || null,
          effectType,
          params,
          keyframes: keyframes || null,
        });
        await refreshPresets();
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      }
    },
    [refreshPresets],
  );

  const loadPreset = useCallback(async (presetId: string): Promise<EffectPreset> => {
    try {
      setError(null);
      return await invoke<EffectPreset>('load_effect_preset', { presetId });
    } catch (errorValue) {
      const msg = errorValue instanceof Error ? errorValue.message : String(errorValue);
      setError(msg);
      throw errorValue;
    }
  }, []);

  const deletePreset = useCallback(
    async (presetId: string): Promise<void> => {
      try {
        setError(null);
        await invoke('delete_effect_preset', { presetId });
        await refreshPresets();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      }
    },
    [refreshPresets],
  );

  return {
    presets,
    loading,
    error,
    refreshPresets,
    savePreset,
    loadPreset,
    deletePreset,
  };
}

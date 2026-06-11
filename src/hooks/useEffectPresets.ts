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
  ParamValue,
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

type BackendKeyframe = Omit<Keyframe, 'value'> & { value: SimpleParamValue };

function isTaggedParamValue(value: unknown): value is ParamValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'value' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}

function toBackendParamValue(value: Keyframe['value'] | SimpleParamValue): SimpleParamValue {
  if (isTaggedParamValue(value)) {
    return value.value;
  }

  return value as SimpleParamValue;
}

function inferTaggedParamValue(value: SimpleParamValue): ParamValue {
  if (typeof value === 'number') {
    return { type: 'float', value };
  }
  if (typeof value === 'boolean') {
    return { type: 'bool', value };
  }
  if (typeof value === 'string') {
    return { type: 'string', value };
  }
  if (Array.isArray(value) && value.length === 4) {
    return { type: 'color', value: value as [number, number, number, number] };
  }

  return { type: 'point', value: value as [number, number] };
}

export function serializeEffectPresetKeyframes(
  keyframes?: Record<string, Keyframe[]>,
): Record<string, BackendKeyframe[]> | undefined {
  if (!keyframes || Object.keys(keyframes).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(keyframes).map(([paramName, frames]) => [
      paramName,
      frames.map((frame) => ({
        ...frame,
        value: toBackendParamValue(frame.value),
      })),
    ]),
  );
}

function deserializeEffectPresetKeyframes(
  keyframes?: Record<string, BackendKeyframe[] | Keyframe[]>,
): Record<string, Keyframe[]> | undefined {
  if (!keyframes || Object.keys(keyframes).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(keyframes).map(([paramName, frames]) => [
      paramName,
      frames.map((frame) => ({
        ...frame,
        value: isTaggedParamValue(frame.value)
          ? frame.value
          : inferTaggedParamValue(frame.value as SimpleParamValue),
      })),
    ]),
  );
}

function normalizeLoadedPreset(preset: EffectPreset): EffectPreset {
  return {
    ...preset,
    keyframes: deserializeEffectPresetKeyframes(
      preset.keyframes as Record<string, BackendKeyframe[] | Keyframe[]> | undefined,
    ),
  };
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
          keyframes: serializeEffectPresetKeyframes(keyframes) || null,
        });
        await refreshPresets();
        return normalizeLoadedPreset(result);
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
      const result = await invoke<EffectPreset>('load_effect_preset', { presetId });
      return normalizeLoadedPreset(result);
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

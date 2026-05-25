/**
 * useQualifier Hook
 *
 * Hook for HSL Qualifier (selective color correction) operations.
 * Connects QualifierPanel UI to backend IPC commands.
 *
 * @module hooks/useQualifier
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  type QualifierValues,
  type QualifierParamName,
  type QualifierPreset,
  DEFAULT_QUALIFIER_VALUES,
  QUALIFIER_PRESETS,
  QUALIFIER_CONSTRAINTS,
  paramsToQualifierValues,
} from '@/types/qualifier';
import type { ClipId, EffectId } from '@/types';
import { createLogger } from '@/services/logger';
import { executeProjectCommandByType } from '@/services/projectMutationGateway';

const logger = createLogger('useQualifier');

// =============================================================================
// Constants
// =============================================================================

/** Debounce delay for IPC calls (ms) */
const DEBOUNCE_DELAY = 150;

const NUMERIC_QUALIFIER_KEYS = [
  'hue_center',
  'hue_width',
  'sat_min',
  'sat_max',
  'lum_min',
  'lum_max',
  'softness',
  'hue_shift',
  'sat_adjust',
  'lum_adjust',
] as const;

const QUALIFIER_KEYS: ReadonlyArray<keyof QualifierValues> = [...NUMERIC_QUALIFIER_KEYS, 'invert'];

// =============================================================================
// Types
// =============================================================================

export interface UseQualifierOptions {
  /** The clip this qualifier belongs to */
  clipId: ClipId;
  /** Optional effect ID (if already created) */
  effectId?: EffectId;
  /** Initial values (overrides fetch) */
  initialValues?: QualifierValues;
}

export interface UseQualifierResult {
  /** Current qualifier values */
  values: QualifierValues;
  /** Update a single parameter */
  updateValue: <K extends keyof QualifierValues>(key: K, value: QualifierValues[K]) => void;
  /** Apply a preset configuration */
  applyPreset: (preset: Exclude<QualifierPreset, 'custom'>) => void;
  /** Reset to default values */
  reset: () => void;
  /** Whether preview mode is enabled */
  previewEnabled: boolean;
  /** Toggle preview mode */
  setPreviewEnabled: (enabled: boolean) => void;
  /** Whether values have been modified */
  isDirty: boolean;
  /** Whether loading initial data */
  isLoading: boolean;
  /** Whether saving changes */
  isSaving: boolean;
  /** Current error message */
  error: string | null;
  /** Clear error state */
  clearError: () => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Clamps a numeric value within the constraint bounds.
 */
function clampValue<K extends keyof QualifierValues>(
  key: K,
  value: QualifierValues[K],
): QualifierValues[K] {
  if (key === 'invert') {
    return value; // Boolean, no clamping needed
  }

  const constraint = QUALIFIER_CONSTRAINTS[key as keyof typeof QUALIFIER_CONSTRAINTS];
  if (!constraint || typeof value !== 'number') {
    return value;
  }

  return Math.max(constraint.min, Math.min(constraint.max, value)) as QualifierValues[K];
}

function normalizeValueAgainstCurrentState<K extends keyof QualifierValues>(
  key: K,
  value: QualifierValues[K],
  currentValues: QualifierValues,
): QualifierValues[K] {
  const clampedValue = clampValue(key, value);

  if (typeof clampedValue !== 'number') {
    return clampedValue;
  }

  if (key === 'sat_min' && clampedValue > currentValues.sat_max) {
    return currentValues.sat_max as QualifierValues[K];
  }
  if (key === 'sat_max' && clampedValue < currentValues.sat_min) {
    return currentValues.sat_min as QualifierValues[K];
  }
  if (key === 'lum_min' && clampedValue > currentValues.lum_max) {
    return currentValues.lum_max as QualifierValues[K];
  }
  if (key === 'lum_max' && clampedValue < currentValues.lum_min) {
    return currentValues.lum_min as QualifierValues[K];
  }

  return clampedValue;
}

/**
 * Compares two qualifier values for equality.
 */
function areValuesEqual(a: QualifierValues, b: QualifierValues): boolean {
  return (
    a.hue_center === b.hue_center &&
    a.hue_width === b.hue_width &&
    a.sat_min === b.sat_min &&
    a.sat_max === b.sat_max &&
    a.lum_min === b.lum_min &&
    a.lum_max === b.lum_max &&
    a.softness === b.softness &&
    a.hue_shift === b.hue_shift &&
    a.sat_adjust === b.sat_adjust &&
    a.lum_adjust === b.lum_adjust &&
    a.invert === b.invert
  );
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useQualifier({
  clipId,
  effectId,
  initialValues,
}: UseQualifierOptions): UseQualifierResult {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [values, setValues] = useState<QualifierValues>(initialValues ?? DEFAULT_QUALIFIER_VALUES);
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valuesRef = useRef<QualifierValues>(initialValues ?? DEFAULT_QUALIFIER_VALUES);

  // Track original values for dirty detection
  const originalValuesRef = useRef<QualifierValues>(initialValues ?? DEFAULT_QUALIFIER_VALUES);

  // Debounce timer ref - use ReturnType for cross-environment compatibility
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pending updates for batching
  const pendingUpdatesRef = useRef<Partial<QualifierValues>>({});
  const modifiedKeysRef = useRef<Set<keyof QualifierValues>>(new Set());

  // ---------------------------------------------------------------------------
  // Computed State
  // ---------------------------------------------------------------------------

  const isDirty = !areValuesEqual(values, originalValuesRef.current);

  const clearPendingDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingUpdatesRef.current = {};
  }, []);

  // ---------------------------------------------------------------------------
  // Fetch Initial Values
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!effectId || initialValues) {
      return; // No need to fetch if no effectId or initialValues provided
    }

    let cancelled = false;

    const fetchParams = async () => {
      setIsLoading(true);
      setError(null);

      try {
        logger.debug('Fetching effect params', { clipId, effectId });

        const params = await invoke<Record<string, unknown>>('get_effect_params', {
          effectId,
        });

        if (cancelled) return;

        const qualifierValues = paramsToQualifierValues(params);
        originalValuesRef.current = qualifierValues;
        setValues((prev) => {
          const modifiedKeys = modifiedKeysRef.current;
          if (modifiedKeys.size === 0) {
            valuesRef.current = qualifierValues;
            return qualifierValues;
          }

          const merged: QualifierValues = { ...prev };
          for (const key of NUMERIC_QUALIFIER_KEYS) {
            if (!modifiedKeys.has(key)) {
              merged[key] = qualifierValues[key];
            }
          }
          if (!modifiedKeys.has('invert')) {
            merged.invert = qualifierValues.invert;
          }
          valuesRef.current = merged;
          return merged;
        });

        logger.info('Effect params loaded', { clipId, effectId });
      } catch (err) {
        if (cancelled) return;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to fetch effect params', { error: err, clipId, effectId });
        setError(errorMsg);
        // Keep default values on error
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchParams();

    return () => {
      cancelled = true;
    };
  }, [clipId, effectId, initialValues]);

  // ---------------------------------------------------------------------------
  // Sync to Backend (Debounced)
  // ---------------------------------------------------------------------------

  const syncToBackend = useCallback(
    async (paramName: QualifierParamName, value: QualifierValues[typeof paramName]) => {
      if (!effectId) {
        return; // No backend sync without effectId
      }

      try {
        setIsSaving(true);

        await executeProjectCommandByType('UpdateEffect', {
          effectId,
          params: {
            [paramName]: value,
          },
        });

        logger.debug('Param synced to backend', { clipId, effectId, paramName, value });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to sync param', { error: err, clipId, effectId, paramName });
        setError(errorMsg);
      } finally {
        setIsSaving(false);
      }
    },
    [clipId, effectId],
  );

  const syncAllToBackend = useCallback(
    async (newValues: QualifierValues) => {
      if (!effectId) {
        return;
      }

      try {
        setIsSaving(true);

        await executeProjectCommandByType('UpdateEffect', {
          effectId,
          params: newValues,
        });

        logger.debug('All params synced to backend', { clipId, effectId });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to sync all params', { error: err, clipId, effectId });
        setError(errorMsg);
      } finally {
        setIsSaving(false);
      }
    },
    [clipId, effectId],
  );

  // ---------------------------------------------------------------------------
  // Update Single Value
  // ---------------------------------------------------------------------------

  const updateValue = useCallback(
    <K extends keyof QualifierValues>(key: K, value: QualifierValues[K]) => {
      modifiedKeysRef.current.add(key);
      const currentValues = valuesRef.current;
      const normalizedValue = normalizeValueAgainstCurrentState(key, value, currentValues);
      const nextValues = { ...currentValues, [key]: normalizedValue };

      valuesRef.current = nextValues;
      setValues(nextValues);

      // Clear previous debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      // Store pending update
      pendingUpdatesRef.current[key] = normalizedValue;

      // Debounce IPC call
      debounceTimerRef.current = setTimeout(() => {
        const updates = pendingUpdatesRef.current;
        pendingUpdatesRef.current = {};

        // Sync each pending update
        Object.entries(updates).forEach(([paramName, paramValue]) => {
          syncToBackend(paramName as QualifierParamName, paramValue);
        });

        debounceTimerRef.current = null;
      }, DEBOUNCE_DELAY);
    },
    [syncToBackend],
  );

  // ---------------------------------------------------------------------------
  // Apply Preset
  // ---------------------------------------------------------------------------

  const applyPreset = useCallback(
    (preset: Exclude<QualifierPreset, 'custom'>) => {
      clearPendingDebounce();
      modifiedKeysRef.current = new Set(QUALIFIER_KEYS);
      const presetValues = QUALIFIER_PRESETS[preset];

      valuesRef.current = presetValues;
      setValues(presetValues);
      syncAllToBackend(presetValues);

      logger.info('Preset applied', { preset });
    },
    [clearPendingDebounce, syncAllToBackend],
  );

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  const reset = useCallback(() => {
    clearPendingDebounce();
    modifiedKeysRef.current = new Set();
    valuesRef.current = DEFAULT_QUALIFIER_VALUES;
    setValues(DEFAULT_QUALIFIER_VALUES);
    originalValuesRef.current = DEFAULT_QUALIFIER_VALUES;
    setError(null);

    syncAllToBackend(DEFAULT_QUALIFIER_VALUES);

    logger.info('Qualifier reset to defaults');
  }, [clearPendingDebounce, syncAllToBackend]);

  // ---------------------------------------------------------------------------
  // Clear Error
  // ---------------------------------------------------------------------------

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      // Clear pending debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      // Flush any pending updates before unmount
      const pendingUpdates = pendingUpdatesRef.current;
      if (effectId && Object.keys(pendingUpdates).length > 0) {
        pendingUpdatesRef.current = {};
        // Fire and forget - component is unmounting
        Promise.resolve(
          executeProjectCommandByType('UpdateEffect', {
            effectId,
            params: pendingUpdates,
          }),
        ).catch((err) => {
          logger.warn('Failed to flush pending updates on unmount', {
            clipId,
            effectId,
            error: err,
          });
        });
      }
    };
  }, [clipId, effectId]);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    values,
    updateValue,
    applyPreset,
    reset,
    previewEnabled,
    setPreviewEnabled,
    isDirty,
    isLoading,
    isSaving,
    error,
    clearError,
  };
}

export default useQualifier;

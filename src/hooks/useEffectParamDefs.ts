/**
 * useEffectParamDefs Hook
 *
 * Provides parameter definitions for an effect.
 * Used by EffectInspector to render appropriate controls.
 */

import { useMemo } from 'react';
import type { Effect, ParamDef } from '@/types';
import { getEffectParamDefs } from '@/utils/effectParamDefs';

/**
 * Get parameter definitions for an effect.
 *
 * @param effect - The effect to get param defs for (null returns empty array)
 * @returns Array of ParamDef for the effect type
 */
export function useEffectParamDefs(effect: Effect | null): ParamDef[] {
  const effectType = effect?.effectType;
  return useMemo(() => {
    if (!effectType) {
      return [];
    }
    return getEffectParamDefs(effectType);
  }, [effectType]);
}

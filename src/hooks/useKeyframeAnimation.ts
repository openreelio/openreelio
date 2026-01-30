/**
 * useKeyframeAnimation Hook
 *
 * Provides animated parameter values based on keyframes and current playhead time.
 * Used for real-time preview of keyframed effect parameters.
 *
 * Performance: Uses stable references and proper memoization to prevent
 * unnecessary re-renders during playback.
 */

import { useMemo, useRef } from 'react';
import type { Effect, Keyframe, ParamValue, SimpleParamValue } from '@/types';
import { getValueAtTime, type InterpolatedValue } from '@/utils/keyframeInterpolation';

// Stable empty object reference to avoid creating new objects on each render
const EMPTY_KEYFRAMES: Record<string, Keyframe[]> = Object.freeze({});

// =============================================================================
// Types
// =============================================================================

/** Options for useAnimatedEffect */
export interface UseAnimatedEffectOptions {
  /** Start time of the effect on the timeline (for offset calculation) */
  effectStartTime?: number;
}

/** Animated parameter values */
export type AnimatedParams = Record<string, SimpleParamValue>;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Creates a stable reference for keyframes array comparison.
 * Returns true if keyframes are structurally equal.
 */
function keyframesEqual(a: Keyframe[], b: Keyframe[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].timeOffset !== b[i].timeOffset ||
        a[i].easing !== b[i].easing) {
      return false;
    }
    // Deep compare values by type and value
    const aVal = a[i].value;
    const bVal = b[i].value;
    if (aVal.type !== bVal.type) return false;
    if (Array.isArray(aVal.value) && Array.isArray(bVal.value)) {
      if (aVal.value.length !== bVal.value.length) return false;
      for (let j = 0; j < aVal.value.length; j++) {
        if (aVal.value[j] !== bVal.value[j]) return false;
      }
    } else if (aVal.value !== bVal.value) {
      return false;
    }
  }
  return true;
}

// =============================================================================
// useKeyframeAnimation Hook
// =============================================================================

/**
 * Get the interpolated value at a specific time from keyframes.
 *
 * Performance: Uses stable keyframe reference detection to avoid
 * unnecessary recalculations when keyframes haven't actually changed.
 *
 * @param keyframes - Array of keyframes for a single parameter
 * @param time - Current time in seconds
 * @param defaultValue - Default value if no keyframes exist
 * @returns Interpolated value at the given time
 */
export function useKeyframeAnimation(
  keyframes: Keyframe[],
  time: number,
  defaultValue?: ParamValue
): InterpolatedValue | undefined {
  // Use ref to track previous keyframes for stable comparison
  const prevKeyframesRef = useRef<Keyframe[]>(keyframes);
  const stableKeyframesRef = useRef<Keyframe[]>(keyframes);

  // Only update stable reference if keyframes actually changed
  if (!keyframesEqual(prevKeyframesRef.current, keyframes)) {
    prevKeyframesRef.current = keyframes;
    stableKeyframesRef.current = keyframes;
  }

  const stableKeyframes = stableKeyframesRef.current;
  const defaultInterpolated = defaultValue?.value as InterpolatedValue | undefined;

  return useMemo(() => {
    if (stableKeyframes.length === 0) {
      return defaultInterpolated;
    }
    return getValueAtTime(stableKeyframes, time);
  }, [stableKeyframes, time, defaultInterpolated]);
}

// =============================================================================
// useAnimatedEffect Hook
// =============================================================================

/**
 * Get all animated parameter values for an effect at a specific time.
 *
 * This hook calculates the current value for each parameter, taking into account
 * both static params and keyframed animation.
 *
 * Performance: Optimized to minimize object allocations during playback by
 * reusing previous result when values haven't changed.
 *
 * @param effect - Effect with params and keyframes
 * @param time - Current timeline time in seconds
 * @param options - Animation options
 * @returns Object with current values for all parameters
 */
export function useAnimatedEffect(
  effect: Effect,
  time: number,
  options: UseAnimatedEffectOptions = {}
): AnimatedParams {
  const { effectStartTime = 0 } = options;

  // Track previous result for optimization
  const prevResultRef = useRef<AnimatedParams | null>(null);
  const prevEffectIdRef = useRef<string>('');
  const prevEnabledRef = useRef<boolean>(true);

  return useMemo(() => {
    // If effect is disabled, return static params
    if (!effect.enabled) {
      // Cache check for disabled state - only reuse if was previously disabled with same effect
      if (prevEnabledRef.current === false &&
          effect.id === prevEffectIdRef.current &&
          prevResultRef.current === effect.params) {
        return prevResultRef.current;
      }
      prevEnabledRef.current = false;
      prevEffectIdRef.current = effect.id;
      prevResultRef.current = effect.params;
      return effect.params;
    }

    // Calculate effect-local time with validation
    const safeTime = Number.isFinite(time) ? time : 0;
    const safeStartTime = Number.isFinite(effectStartTime) ? effectStartTime : 0;
    const localTime = safeTime - safeStartTime;

    // Build animated params object
    const animatedParams: AnimatedParams = {};
    // Force recalculation if effect changed or was previously disabled
    let hasChanges = prevResultRef.current === null ||
                     effect.id !== prevEffectIdRef.current ||
                     prevEnabledRef.current === false;

    // Validate keyframes object exists, using stable empty reference for undefined
    const effectKeyframes = effect.keyframes ?? EMPTY_KEYFRAMES;

    // Process each parameter with safe fallbacks
    for (const [paramName, staticValue] of Object.entries(effect.params)) {
      const keyframes = effectKeyframes[paramName];

      if (keyframes && Array.isArray(keyframes) && keyframes.length > 0) {
        // Has keyframes - interpolate with fallback to static value
        const animatedValue = getValueAtTime(keyframes, localTime);

        // Critical: validate result and fallback to static value if interpolation fails
        // getValueAtTime may return undefined for empty keyframes or invalid data
        if (animatedValue !== undefined && animatedValue !== null) {
          animatedParams[paramName] = animatedValue as SimpleParamValue;
        } else {
          // Interpolation failed - use static value as fallback
          animatedParams[paramName] = staticValue;
        }

        // Check if value changed from previous
        if (!hasChanges && prevResultRef.current) {
          const prevValue = prevResultRef.current[paramName];
          if (prevValue !== animatedParams[paramName]) {
            hasChanges = true;
          }
        }
      } else {
        // No keyframes - use static value
        animatedParams[paramName] = staticValue;

        // Check if value changed from previous
        if (!hasChanges && prevResultRef.current) {
          const prevValue = prevResultRef.current[paramName];
          if (prevValue !== staticValue) {
            hasChanges = true;
          }
        }
      }
    }

    // Return previous result if no changes (stable reference)
    if (!hasChanges && prevResultRef.current) {
      return prevResultRef.current;
    }

    // Cache and return new result
    prevEnabledRef.current = true; // Effect is enabled here
    prevEffectIdRef.current = effect.id;
    prevResultRef.current = animatedParams;

    return animatedParams;
  // Use stable empty reference for keyframes to prevent unnecessary recalculations
  }, [effect.id, effect.enabled, effect.params, effect.keyframes, time, effectStartTime]);
}

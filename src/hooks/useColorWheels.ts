/**
 * useColorWheels Hook
 *
 * State management hook for Lift/Gamma/Gain color wheels.
 * Provides convenient methods for updating individual wheels
 * and generating FFmpeg filter strings.
 *
 * @module hooks/useColorWheels
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  type LiftGammaGain,
  type ColorOffset,
  createNeutralLGG,
  isNeutralLGG,
  lggToFFmpegFilter,
} from '@/utils/colorWheel';

// =============================================================================
// Types
// =============================================================================

export interface WheelLuminance {
  lift: number;
  gamma: number;
  gain: number;
}

export interface UseColorWheelsOptions {
  /** Initial LGG values */
  initialValue?: LiftGammaGain;
  /** Initial luminance values */
  initialLuminance?: WheelLuminance;
  /** Called when any value changes */
  onChange?: (value: LiftGammaGain, luminance: WheelLuminance) => void;
}

export interface UseColorWheelsReturn {
  /** Current LGG values */
  lgg: LiftGammaGain;
  /** Current luminance values */
  luminance: WheelLuminance;
  /** Whether all values are neutral */
  isNeutral: boolean;

  // Individual wheel setters
  setLift: (value: ColorOffset) => void;
  setGamma: (value: ColorOffset) => void;
  setGain: (value: ColorOffset) => void;

  // Complete LGG setter
  setLGG: (value: LiftGammaGain) => void;

  // Luminance setters
  setLiftLuminance: (value: number) => void;
  setGammaLuminance: (value: number) => void;
  setGainLuminance: (value: number) => void;
  setAllLuminance: (value: WheelLuminance) => void;

  // Reset functions
  reset: () => void;
  resetLift: () => void;
  resetGamma: () => void;
  resetGain: () => void;

  // FFmpeg integration
  toFFmpegFilter: () => string;
}

// =============================================================================
// Constants
// =============================================================================

const NEUTRAL_LUMINANCE: WheelLuminance = {
  lift: 0,
  gamma: 0,
  gain: 0,
};

const NEUTRAL_OFFSET: ColorOffset = { r: 0, g: 0, b: 0 };

// =============================================================================
// Hook Implementation
// =============================================================================

export function useColorWheels(
  options: UseColorWheelsOptions = {}
): UseColorWheelsReturn {
  const {
    initialValue,
    initialLuminance,
    onChange,
  } = options;

  // State
  const [lgg, setLggState] = useState<LiftGammaGain>(
    initialValue ?? createNeutralLGG()
  );
  const [luminance, setLuminanceState] = useState<WheelLuminance>(
    initialLuminance ?? { ...NEUTRAL_LUMINANCE }
  );

  // Track if this is the initial render
  const isInitialRender = useRef(true);

  // Call onChange when values change (but not on initial render)
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    onChange?.(lgg, luminance);
  }, [lgg, luminance, onChange]);

  // Individual wheel setters
  const setLift = useCallback((value: ColorOffset) => {
    setLggState((prev) => ({ ...prev, lift: value }));
  }, []);

  const setGamma = useCallback((value: ColorOffset) => {
    setLggState((prev) => ({ ...prev, gamma: value }));
  }, []);

  const setGain = useCallback((value: ColorOffset) => {
    setLggState((prev) => ({ ...prev, gain: value }));
  }, []);

  // Complete LGG setter
  const setLGG = useCallback((value: LiftGammaGain) => {
    setLggState(value);
  }, []);

  // Luminance setters
  const setLiftLuminance = useCallback((value: number) => {
    setLuminanceState((prev) => ({ ...prev, lift: value }));
  }, []);

  const setGammaLuminance = useCallback((value: number) => {
    setLuminanceState((prev) => ({ ...prev, gamma: value }));
  }, []);

  const setGainLuminance = useCallback((value: number) => {
    setLuminanceState((prev) => ({ ...prev, gain: value }));
  }, []);

  const setAllLuminance = useCallback((value: WheelLuminance) => {
    setLuminanceState(value);
  }, []);

  // Reset functions
  const reset = useCallback(() => {
    setLggState(createNeutralLGG());
    setLuminanceState({ ...NEUTRAL_LUMINANCE });
  }, []);

  const resetLift = useCallback(() => {
    setLggState((prev) => ({ ...prev, lift: { ...NEUTRAL_OFFSET } }));
    setLuminanceState((prev) => ({ ...prev, lift: 0 }));
  }, []);

  const resetGamma = useCallback(() => {
    setLggState((prev) => ({ ...prev, gamma: { ...NEUTRAL_OFFSET } }));
    setLuminanceState((prev) => ({ ...prev, gamma: 0 }));
  }, []);

  const resetGain = useCallback(() => {
    setLggState((prev) => ({ ...prev, gain: { ...NEUTRAL_OFFSET } }));
    setLuminanceState((prev) => ({ ...prev, gain: 0 }));
  }, []);

  // Check if all values are neutral
  const isNeutral = useMemo(() => {
    return (
      isNeutralLGG(lgg) &&
      luminance.lift === 0 &&
      luminance.gamma === 0 &&
      luminance.gain === 0
    );
  }, [lgg, luminance]);

  // Generate FFmpeg filter string
  const toFFmpegFilter = useCallback(() => {
    return lggToFFmpegFilter(lgg);
  }, [lgg]);

  return {
    lgg,
    luminance,
    isNeutral,
    setLift,
    setGamma,
    setGain,
    setLGG,
    setLiftLuminance,
    setGammaLuminance,
    setGainLuminance,
    setAllLuminance,
    reset,
    resetLift,
    resetGamma,
    resetGain,
    toFFmpegFilter,
  };
}

export default useColorWheels;

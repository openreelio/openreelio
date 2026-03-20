/**
 * useColorComparison Hook
 *
 * Manages state for the before/after color comparison overlay.
 * Supports split (vertical divider), wipe (horizontal line),
 * and side-by-side comparison modes with a draggable divider.
 */

import { useState, useCallback } from 'react';

// =============================================================================
// Types
// =============================================================================

export type ComparisonMode = 'split' | 'wipe' | 'side-by-side';

export interface UseColorComparisonReturn {
  /** Whether comparison overlay is active */
  isEnabled: boolean;
  /** Current comparison mode */
  mode: ComparisonMode;
  /** Divider position as percentage (5-95) */
  dividerPosition: number;
  /** Toggle comparison on/off */
  toggle: () => void;
  /** Set comparison mode */
  setMode: (mode: ComparisonMode) => void;
  /** Set divider position (clamped to 5-95%) */
  setDividerPosition: (position: number) => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Minimum divider position to prevent fully collapsed views */
const MIN_POSITION = 5;
/** Maximum divider position */
const MAX_POSITION = 95;
/** Default divider position (center) */
const DEFAULT_POSITION = 50;

// =============================================================================
// Hook
// =============================================================================

export function useColorComparison(): UseColorComparisonReturn {
  const [isEnabled, setIsEnabled] = useState(false);
  const [mode, setModeState] = useState<ComparisonMode>('split');
  const [dividerPosition, setDividerPositionState] = useState(DEFAULT_POSITION);

  const toggle = useCallback(() => {
    setIsEnabled((prev) => !prev);
  }, []);

  const setMode = useCallback((newMode: ComparisonMode) => {
    setModeState(newMode);
  }, []);

  const setDividerPosition = useCallback((position: number) => {
    setDividerPositionState(Math.max(MIN_POSITION, Math.min(MAX_POSITION, position)));
  }, []);

  return {
    isEnabled,
    mode,
    dividerPosition,
    toggle,
    setMode,
    setDividerPosition,
  };
}

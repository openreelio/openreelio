/**
 * useMulticamSession Hook
 *
 * Orchestration hook that bridges useMulticam, useMulticamKeyboardShortcuts,
 * and playbackStore. Provides a single entry point for multicam editing
 * integration in the editor view.
 *
 * @module hooks/useMulticamSession
 */

import { useCallback } from 'react';
import { usePlaybackStore } from '@/stores';
import { useMulticam, type UseMulticamReturn } from './useMulticam';
import { useMulticamKeyboardShortcuts } from './useMulticamKeyboardShortcuts';
import type { MulticamGroup } from '@/utils/multicam';

// =============================================================================
// Types
// =============================================================================

export interface UseMulticamSessionOptions {
  /** Multicam group to edit (null = inactive) */
  group: MulticamGroup | null;
  /** Editing mode: 'view' for switching, 'record' for recording switches */
  mode: 'view' | 'record';
  /** Callback when the group is modified */
  onChange?: (group: MulticamGroup) => void;
}

export interface UseMulticamSessionReturn extends UseMulticamReturn {
  /** Whether multicam session is active */
  isActive: boolean;
  /** Whether recording mode is enabled */
  isRecording: boolean;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useMulticamSession(
  options: UseMulticamSessionOptions
): UseMulticamSessionReturn {
  const { group, mode, onChange } = options;

  const isActive = group !== null;
  const isRecording = mode === 'record';

  // Read playback state
  const currentTime = usePlaybackStore((state) => state.currentTime);

  // Core multicam state management
  const multicam = useMulticam({
    group,
    isRecording,
    onChange,
  });

  // Angle switch callback for keyboard shortcuts (view mode)
  const handleSwitchAngle = useCallback(
    (angleIndex: number) => {
      multicam.switchAngle(angleIndex);
    },
    [multicam]
  );

  // Angle switch callback for keyboard shortcuts (record mode)
  const handleSwitchAngleAt = useCallback(
    (angleIndex: number, timeSec: number) => {
      multicam.switchAngleAt(angleIndex, timeSec);
    },
    [multicam]
  );

  // Global keyboard shortcuts (1-9 for angle switching)
  useMulticamKeyboardShortcuts({
    enabled: isActive,
    angleCount: group?.angles.length ?? 0,
    isRecording,
    currentTimeSec: currentTime,
    onSwitchAngle: handleSwitchAngle,
    onSwitchAngleAt: handleSwitchAngleAt,
  });

  return {
    ...multicam,
    isActive,
    isRecording,
  };
}

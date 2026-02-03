/**
 * useMulticam Hook
 *
 * Provides state management and operations for multicam editing.
 * Features:
 * - Active angle switching
 * - Angle switch recording
 * - Grid layout management
 * - Audio mix mode control
 * - Keyboard shortcuts for quick switching
 *
 * @module hooks/useMulticam
 */

import { useState, useCallback, useMemo } from 'react';
import { nanoid } from 'nanoid';
import {
  type MulticamGroup,
  type MulticamAngle,
  type AngleSwitch,
  type AudioMixMode,
  type AngleAtTimeResult,
  getAngleAtTime,
  sortAngleSwitches,
} from '@/utils/multicam';

// =============================================================================
// Types
// =============================================================================

/** Grid layout for the multicam viewer */
export interface GridLayout {
  rows: number;
  cols: number;
}

/** Options for the useMulticam hook */
export interface UseMulticamOptions {
  /** Initial multicam group */
  group?: MulticamGroup | null;
  /** Whether to record angle switches */
  isRecording?: boolean;
  /** Callback when group changes */
  onChange?: (group: MulticamGroup) => void;
  /** Initial grid layout */
  initialGridLayout?: GridLayout;
}

/** Return type of the useMulticam hook */
export interface UseMulticamReturn {
  /** Current multicam group */
  group: MulticamGroup | null;
  /** Currently active angle */
  activeAngle: MulticamAngle | null;
  /** Index of the active angle */
  activeAngleIndex: number;
  /** Current grid layout */
  gridLayout: GridLayout;
  /** Angles visible in current grid layout */
  visibleAngles: MulticamAngle[];
  /** Current audio mix mode */
  audioMixMode: AudioMixMode;
  /** Index of hovered angle (for preview) */
  hoveredAngleIndex: number | null;
  /** The angle to show in main preview (hovered or active) */
  previewAngle: MulticamAngle | null;

  /** Switch to a different angle */
  switchAngle: (angleIndex: number) => void;
  /** Switch to a different angle at a specific time (for recording) */
  switchAngleAt: (angleIndex: number, timeSec: number) => void;
  /** Remove an angle switch */
  removeSwitch: (switchId: string) => void;
  /** Update an angle switch time */
  updateSwitchTime: (switchId: string, newTimeSec: number) => void;
  /** Clear all angle switches */
  clearSwitches: () => void;
  /** Update the grid layout */
  setGridLayout: (layout: GridLayout) => void;
  /** Get angle at a specific grid position */
  getAngleAtGridPosition: (row: number, col: number) => MulticamAngle | null;
  /** Update audio mix mode */
  setAudioMixMode: (mode: AudioMixMode) => void;
  /** Get angle index at a specific timeline time */
  getAngleIndexAtTime: (timeSec: number) => AngleAtTimeResult | null;
  /** Handle keyboard shortcut */
  handleKeyPress: (key: string) => void;
  /** Update group name */
  updateGroupName: (name: string) => void;
  /** Add an angle to the group */
  addAngle: (angle: MulticamAngle) => void;
  /** Remove an angle from the group */
  removeAngle: (angleId: string) => void;
  /** Set hovered angle index */
  setHoveredAngle: (index: number | null) => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

export function useMulticam(options: UseMulticamOptions = {}): UseMulticamReturn {
  const {
    group: initialGroup = null,
    isRecording = false,
    onChange,
    initialGridLayout = { rows: 2, cols: 2 },
  } = options;

  // State
  const [group, setGroup] = useState<MulticamGroup | null>(initialGroup);
  const [gridLayout, setGridLayout] = useState<GridLayout>(initialGridLayout);
  const [hoveredAngleIndex, setHoveredAngleIndex] = useState<number | null>(null);

  // Derived values
  const activeAngleIndex = group?.activeAngleIndex ?? 0;
  const activeAngle = group?.angles[activeAngleIndex] ?? null;
  const audioMixMode = group?.audioMixMode ?? 'active';

  const visibleAngles = useMemo(() => {
    if (!group) return [];
    const maxVisible = gridLayout.rows * gridLayout.cols;
    return group.angles.slice(0, maxVisible);
  }, [group, gridLayout]);

  const previewAngle = useMemo(() => {
    if (!group) return null;
    if (hoveredAngleIndex !== null && hoveredAngleIndex < group.angles.length) {
      return group.angles[hoveredAngleIndex];
    }
    return activeAngle;
  }, [group, hoveredAngleIndex, activeAngle]);

  // Update group and notify
  const updateGroup = useCallback(
    (updater: (g: MulticamGroup) => MulticamGroup) => {
      setGroup((current) => {
        if (!current) return current;
        const updated = updater(current);
        onChange?.(updated);
        return updated;
      });
    },
    [onChange]
  );

  // Switch to a different angle
  const switchAngle = useCallback(
    (angleIndex: number) => {
      if (!group) return;
      if (angleIndex < 0 || angleIndex >= group.angles.length) return;
      if (angleIndex === group.activeAngleIndex) return;

      updateGroup((g) => ({
        ...g,
        activeAngleIndex: angleIndex,
        modifiedAt: new Date().toISOString(),
      }));
    },
    [group, updateGroup]
  );

  // Switch to a different angle at a specific time (for recording)
  const switchAngleAt = useCallback(
    (angleIndex: number, timeSec: number) => {
      if (!group) return;
      if (angleIndex < 0 || angleIndex >= group.angles.length) return;

      const currentIndex = group.activeAngleIndex;
      if (angleIndex === currentIndex) return;

      if (isRecording) {
        // Create a new switch record
        const newSwitch: AngleSwitch = {
          id: nanoid(),
          timeSec,
          fromAngleIndex: currentIndex,
          toAngleIndex: angleIndex,
          transitionType: 'cut',
        };

        updateGroup((g) => ({
          ...g,
          activeAngleIndex: angleIndex,
          angleSwitches: sortAngleSwitches([...g.angleSwitches, newSwitch]),
          modifiedAt: new Date().toISOString(),
        }));
      } else {
        // Just switch without recording
        updateGroup((g) => ({
          ...g,
          activeAngleIndex: angleIndex,
          modifiedAt: new Date().toISOString(),
        }));
      }
    },
    [group, isRecording, updateGroup]
  );

  // Remove an angle switch
  const removeSwitch = useCallback(
    (switchId: string) => {
      updateGroup((g) => ({
        ...g,
        angleSwitches: g.angleSwitches.filter((s) => s.id !== switchId),
        modifiedAt: new Date().toISOString(),
      }));
    },
    [updateGroup]
  );

  // Update an angle switch time
  const updateSwitchTime = useCallback(
    (switchId: string, newTimeSec: number) => {
      updateGroup((g) => ({
        ...g,
        angleSwitches: sortAngleSwitches(
          g.angleSwitches.map((s) =>
            s.id === switchId ? { ...s, timeSec: newTimeSec } : s
          )
        ),
        modifiedAt: new Date().toISOString(),
      }));
    },
    [updateGroup]
  );

  // Clear all switches
  const clearSwitches = useCallback(() => {
    updateGroup((g) => ({
      ...g,
      angleSwitches: [],
      modifiedAt: new Date().toISOString(),
    }));
  }, [updateGroup]);

  // Get angle at grid position
  const getAngleAtGridPosition = useCallback(
    (row: number, col: number): MulticamAngle | null => {
      if (!group) return null;
      const index = row * gridLayout.cols + col;
      if (index >= group.angles.length) return null;
      return group.angles[index];
    },
    [group, gridLayout.cols]
  );

  // Set audio mix mode
  const setAudioMixMode = useCallback(
    (mode: AudioMixMode) => {
      updateGroup((g) => ({
        ...g,
        audioMixMode: mode,
        modifiedAt: new Date().toISOString(),
      }));
    },
    [updateGroup]
  );

  // Get angle index at a specific time
  const getAngleIndexAtTime = useCallback(
    (timeSec: number): AngleAtTimeResult | null => {
      if (!group) return null;
      return getAngleAtTime(group, timeSec);
    },
    [group]
  );

  // Handle keyboard shortcuts
  const handleKeyPress = useCallback(
    (key: string) => {
      if (!group) return;

      // Number keys 1-9 for angle switching
      const num = parseInt(key, 10);
      if (!isNaN(num) && num >= 1 && num <= 9) {
        const angleIndex = num - 1;
        if (angleIndex < group.angles.length) {
          switchAngle(angleIndex);
        }
      }
    },
    [group, switchAngle]
  );

  // Update group name
  const updateGroupName = useCallback(
    (name: string) => {
      updateGroup((g) => ({
        ...g,
        name,
        modifiedAt: new Date().toISOString(),
      }));
    },
    [updateGroup]
  );

  // Add an angle to the group
  const addAngle = useCallback(
    (angle: MulticamAngle) => {
      updateGroup((g) => ({
        ...g,
        angles: [...g.angles, angle],
        modifiedAt: new Date().toISOString(),
      }));
    },
    [updateGroup]
  );

  // Remove an angle from the group
  const removeAngle = useCallback(
    (angleId: string) => {
      updateGroup((g) => {
        const newAngles = g.angles.filter((a) => a.id !== angleId);
        const angleIndex = g.angles.findIndex((a) => a.id === angleId);

        // Adjust active angle index if needed
        let newActiveIndex = g.activeAngleIndex;
        if (newActiveIndex >= newAngles.length) {
          newActiveIndex = Math.max(0, newAngles.length - 1);
        }

        // Remove switches referencing the removed angle
        const newSwitches = g.angleSwitches.filter(
          (s) => s.fromAngleIndex !== angleIndex && s.toAngleIndex !== angleIndex
        );

        return {
          ...g,
          angles: newAngles,
          activeAngleIndex: newActiveIndex,
          angleSwitches: newSwitches,
          modifiedAt: new Date().toISOString(),
        };
      });
    },
    [updateGroup]
  );

  // Set hovered angle
  const setHoveredAngle = useCallback((index: number | null) => {
    setHoveredAngleIndex(index);
  }, []);

  return {
    group,
    activeAngle,
    activeAngleIndex,
    gridLayout,
    visibleAngles,
    audioMixMode,
    hoveredAngleIndex,
    previewAngle,
    switchAngle,
    switchAngleAt,
    removeSwitch,
    updateSwitchTime,
    clearSwitches,
    setGridLayout,
    getAngleAtGridPosition,
    setAudioMixMode,
    getAngleIndexAtTime,
    handleKeyPress,
    updateGroupName,
    addAngle,
    removeAngle,
    setHoveredAngle,
  };
}

export default useMulticam;

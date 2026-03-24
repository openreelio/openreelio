/**
 * Hook for fetching and navigating the undo/redo history.
 *
 * Provides the combined history list, current state indicator,
 * and the ability to jump to any point in the history.
 * Automatically refreshes when the project state version changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { invoke } from '@tauri-apps/api/core';

import { useProjectStore } from '@/stores';
import type { UndoHistoryEntry, UndoHistoryInfo } from '@/types';

/**
 * Human-readable labels for known command type names.
 * Unknown types fall back to automatic PascalCase-to-spaced conversion
 * via getCommandLabel() (e.g., "SomeNewCommand" -> "Some New Command").
 */
const COMMAND_LABELS: Record<string, string> = {
  InsertClip: 'Insert Clip',
  AddClip: 'Add Clip',
  RemoveClip: 'Remove Clip',
  DeleteClip: 'Delete Clip',
  MoveClip: 'Move Clip',
  TrimClip: 'Trim Clip',
  SplitClip: 'Split Clip',
  SetClipSpeed: 'Set Clip Speed',
  ReverseClip: 'Reverse Clip',
  FreezeFrame: 'Freeze Frame',
  SetClipEnabled: 'Toggle Clip',
  SetClipMute: 'Mute Clip',
  SetClipTransform: 'Transform Clip',
  SetClipAudio: 'Set Audio',
  SetClipBlendMode: 'Blend Mode',
  AddEffect: 'Add Effect',
  ApplyEffect: 'Apply Effect',
  RemoveEffect: 'Remove Effect',
  UpdateEffect: 'Update Effect',
  AddTrack: 'Add Track',
  InsertTrack: 'Insert Track',
  RemoveTrack: 'Remove Track',
  DeleteTrack: 'Delete Track',
  RenameTrack: 'Rename Track',
  ReorderTracks: 'Reorder Tracks',
  ToggleTrackMute: 'Toggle Track Mute',
  ToggleTrackLock: 'Toggle Track Lock',
  ToggleTrackVisibility: 'Toggle Track Visibility',
  InsertEdit: 'Insert Edit',
  OverwriteEdit: 'Overwrite Edit',
  RippleDelete: 'Ripple Delete',
  Lift: 'Lift Edit',
  ExtractEdit: 'Extract Edit',
  CloseGap: 'Close Gap',
  CloseAllGaps: 'Close All Gaps',
  AddAudioKeyframe: 'Add Audio Keyframe',
  RemoveAudioKeyframe: 'Remove Audio Keyframe',
  MoveAudioKeyframe: 'Move Audio Keyframe',
  SetAudioKeyframeValue: 'Set Audio Keyframe',
  SetAudioFadeIn: 'Audio Fade In',
  SetAudioFadeOut: 'Audio Fade Out',
  SetMasterVolume: 'Master Volume',
  ApplyAudioDucking: 'Audio Ducking',
  CreateCompoundClip: 'Create Compound Clip',
  UnnestCompoundClip: 'Unnest Compound Clip',
  CreateAdjustmentLayer: 'Adjustment Layer',
  GroupClips: 'Group Clips',
  UngroupClips: 'Ungroup Clips',
  LinkClips: 'Link Clips',
  UnlinkClips: 'Unlink Clips',
  DetachAudio: 'Detach Audio',
  PasteEffects: 'Paste Effects',
  PasteAttributes: 'Paste Attributes',
  RemoveAttributes: 'Remove Attributes',
  SetTimeRemap: 'Time Remap',
  ClearTimeRemap: 'Clear Time Remap',
  AddCaption: 'Add Caption',
  RemoveCaption: 'Remove Caption',
  UpdateCaption: 'Update Caption',
  CreateSequence: 'Create Sequence',
  ImportAsset: 'Import Asset',
  AddAsset: 'Add Asset',
  RemoveAsset: 'Remove Asset',
  CreateMarker: 'Add Marker',
  UpdateMarker: 'Update Marker',
  DeleteMarker: 'Delete Marker',
};

/** Returns a human-readable label for a command type */
export function getCommandLabel(commandType: string): string {
  return COMMAND_LABELS[commandType] ?? commandType.replace(/([A-Z])/g, ' $1').trim();
}

export interface UseUndoHistoryReturn {
  /** All undo entries (applied commands, oldest first) */
  undoEntries: UndoHistoryEntry[];
  /** All redo entries (undone commands, next-to-redo first) */
  redoEntries: UndoHistoryEntry[];
  /** Index of current state in combined list (-1 = initial state) */
  currentIndex: number;
  /** Whether the history is being fetched */
  loading: boolean;
  /** Jump to a specific history state by index */
  jumpToState: (targetIndex: number) => Promise<void>;
  /** Manually refresh history from backend */
  refresh: () => Promise<void>;
}

export function useUndoHistory(): UseUndoHistoryReturn {
  const [undoEntries, setUndoEntries] = useState<UndoHistoryEntry[]>([]);
  const [redoEntries, setRedoEntries] = useState<UndoHistoryEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const isJumpingRef = useRef(false);

  const stateVersion = useProjectStore((s) => s.stateVersion);
  const isLoaded = useProjectStore((s) => s.isLoaded);
  const jumpToHistoryState = useProjectStore((s) => s.jumpToHistoryState);

  const refresh = useCallback(async () => {
    if (!isLoaded) return;
    try {
      setLoading(true);
      const info = await invoke<UndoHistoryInfo>('get_undo_history');
      setUndoEntries(info.undoEntries);
      setRedoEntries(info.redoEntries);
      setCurrentIndex(info.currentIndex);
    } catch {
      // Silently ignore — project may not be open
    } finally {
      setLoading(false);
    }
  }, [isLoaded]);

  const jumpToState = useCallback(
    async (targetIndex: number) => {
      if (isJumpingRef.current || targetIndex === currentIndex) return;
      isJumpingRef.current = true;
      try {
        await jumpToHistoryState(targetIndex);
      } finally {
        isJumpingRef.current = false;
        // The store increments stateVersion during a successful jump, but that
        // update occurs while this flag is set. Refresh explicitly so the panel
        // always reflects the new current history index.
        await refresh();
      }
    },
    [refresh, currentIndex, jumpToHistoryState],
  );

  // Auto-refresh when stateVersion changes (after any undo/redo/command)
  useEffect(() => {
    if (isLoaded && !isJumpingRef.current) {
      void refresh();
    }
  }, [stateVersion, isLoaded, refresh]);

  return { undoEntries, redoEntries, currentIndex, loading, jumpToState, refresh };
}

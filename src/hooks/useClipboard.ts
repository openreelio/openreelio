/**
 * useClipboard Hook
 *
 * Provides clipboard operations for clips (copy, cut, paste, duplicate).
 * Manages clipboard state and integrates with the command system.
 *
 * @module hooks/useClipboard
 */

import { useCallback, useMemo } from 'react';
import { useEditorToolStore, type ClipboardItem } from '@/stores/editorToolStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import type { Sequence, Clip, Track } from '@/types';
import { MAX_CLIPBOARD_ITEMS } from '@/constants/editing';

// =============================================================================
// Types
// =============================================================================

export interface ClipboardOperationResult {
  success: boolean;
  message: string;
  clipIds?: string[];
}

export interface UseClipboardOptions {
  /** Current sequence */
  sequence: Sequence | null;
  /** Currently selected clip IDs */
  selectedClipIds: string[];
  /** Callback for copy operation */
  onCopy?: (clips: ClipboardItem[]) => void;
  /** Callback for cut operation */
  onCut?: (clipIds: string[]) => void;
  /** Callback for paste operation */
  onPaste?: (clips: ClipboardItem[], targetTime: number, targetTrackId?: string) => void;
  /** Callback for duplicate operation */
  onDuplicate?: (clipIds: string[], targetTime: number) => void;
  /** Callback to delete clips (for cut operation) */
  onDelete?: (clipIds: string[]) => void;
}

export interface UseClipboardReturn {
  /** Whether there are items in the clipboard */
  hasClipboard: boolean;
  /** Number of items in clipboard */
  clipboardCount: number;
  /** Whether copy operation is available */
  canCopy: boolean;
  /** Whether paste operation is available */
  canPaste: boolean;
  /** Whether cut operation is available */
  canCut: boolean;
  /** Whether duplicate operation is available */
  canDuplicate: boolean;
  /** Copy selected clips to clipboard */
  copy: () => ClipboardOperationResult;
  /** Cut selected clips (copy + delete) */
  cut: () => ClipboardOperationResult;
  /** Paste clips at playhead position */
  paste: (targetTrackId?: string) => ClipboardOperationResult;
  /** Duplicate selected clips immediately after */
  duplicate: () => ClipboardOperationResult;
  /** Clear the clipboard */
  clearClipboard: () => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Find a clip by ID in the sequence
 */
function findClipInSequence(
  sequence: Sequence,
  clipId: string
): { clip: Clip; track: Track } | null {
  for (const track of sequence.tracks) {
    const clip = track.clips.find(c => c.id === clipId);
    if (clip) {
      return { clip, track };
    }
  }
  return null;
}

/**
 * Calculate clip duration
 */
function getClipDuration(clip: Clip): number {
  const safeSpeed = clip.speed > 0 ? clip.speed : 1;
  return (clip.range.sourceOutSec - clip.range.sourceInSec) / safeSpeed;
}

/**
 * Convert a Clip to ClipboardItem
 */
function clipToClipboardItem(clip: Clip, trackId: string): ClipboardItem {
  return {
    type: 'clip',
    clipId: clip.id,
    trackId,
    clipData: {
      assetId: clip.assetId,
      label: clip.label,
      timelineIn: clip.place.timelineInSec,
      sourceIn: clip.range.sourceInSec,
      sourceOut: clip.range.sourceOutSec,
      speed: clip.speed,
      volume: clip.audio.volumeDb,
      opacity: clip.opacity,
    },
  };
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook for clipboard operations on clips.
 *
 * Features:
 * - Copy clips to internal clipboard
 * - Cut clips (copy + delete)
 * - Paste at playhead position
 * - Duplicate clips
 * - Clipboard state management
 *
 * @example
 * ```tsx
 * const { copy, paste, duplicate, canPaste } = useClipboard({
 *   sequence,
 *   selectedClipIds,
 *   onPaste: (clips, time) => handlePaste(clips, time),
 * });
 * ```
 */
export function useClipboard(options: UseClipboardOptions): UseClipboardReturn {
  const {
    sequence,
    selectedClipIds,
    onCopy,
    onCut,
    onPaste,
    onDuplicate,
    onDelete,
  } = options;

  const { clipboard, copyToClipboard, clearClipboard } = useEditorToolStore();
  const { currentTime } = usePlaybackStore();

  // Memoized state values
  const hasClipboard = useMemo(() => {
    return clipboard !== null && clipboard.length > 0;
  }, [clipboard]);

  const clipboardCount = useMemo(() => {
    return clipboard?.length ?? 0;
  }, [clipboard]);

  const canCopy = useMemo(() => {
    return sequence !== null && selectedClipIds.length > 0;
  }, [sequence, selectedClipIds]);

  const canPaste = useMemo(() => {
    return sequence !== null && hasClipboard;
  }, [sequence, hasClipboard]);

  const canCut = canCopy;
  const canDuplicate = canCopy;

  /**
   * Copy selected clips to clipboard
   */
  const copy = useCallback((): ClipboardOperationResult => {
    if (!sequence) {
      return { success: false, message: 'No sequence available' };
    }

    if (selectedClipIds.length === 0) {
      return { success: false, message: 'No clips selected' };
    }

    if (selectedClipIds.length > MAX_CLIPBOARD_ITEMS) {
      return {
        success: false,
        message: `Cannot copy more than ${MAX_CLIPBOARD_ITEMS} clips`,
      };
    }

    const clipboardItems: ClipboardItem[] = [];

    for (const clipId of selectedClipIds) {
      const found = findClipInSequence(sequence, clipId);
      if (found) {
        clipboardItems.push(clipToClipboardItem(found.clip, found.track.id));
      }
    }

    if (clipboardItems.length === 0) {
      return { success: false, message: 'Could not find selected clips' };
    }

    copyToClipboard(clipboardItems);
    onCopy?.(clipboardItems);

    return {
      success: true,
      message: `Copied ${clipboardItems.length} clip(s)`,
      clipIds: clipboardItems.map(c => c.clipId),
    };
  }, [sequence, selectedClipIds, copyToClipboard, onCopy]);

  /**
   * Cut selected clips (copy + delete)
   */
  const cut = useCallback((): ClipboardOperationResult => {
    const copyResult = copy();

    if (!copyResult.success) {
      return copyResult;
    }

    // Delete the original clips
    onDelete?.(selectedClipIds);
    onCut?.(selectedClipIds);

    return {
      success: true,
      message: `Cut ${copyResult.clipIds?.length ?? 0} clip(s)`,
      clipIds: copyResult.clipIds,
    };
  }, [copy, selectedClipIds, onDelete, onCut]);

  /**
   * Paste clips at playhead position
   */
  const paste = useCallback((targetTrackId?: string): ClipboardOperationResult => {
    if (!sequence) {
      return { success: false, message: 'No sequence available' };
    }

    if (!clipboard || clipboard.length === 0) {
      return { success: false, message: 'Clipboard is empty' };
    }

    // Calculate offset from the earliest clip in clipboard
    let earliestTime = Infinity;
    for (const item of clipboard) {
      if (item.clipData.timelineIn < earliestTime) {
        earliestTime = item.clipData.timelineIn;
      }
    }

    // Offset all clips to paste at playhead
    const offsetClips: ClipboardItem[] = clipboard.map(item => ({
      ...item,
      clipData: {
        ...item.clipData,
        timelineIn: item.clipData.timelineIn - earliestTime + currentTime,
      },
    }));

    onPaste?.(offsetClips, currentTime, targetTrackId);

    return {
      success: true,
      message: `Pasted ${clipboard.length} clip(s)`,
      clipIds: clipboard.map(c => c.clipId),
    };
  }, [sequence, clipboard, currentTime, onPaste]);

  /**
   * Duplicate selected clips immediately after
   */
  const duplicate = useCallback((): ClipboardOperationResult => {
    if (!sequence) {
      return { success: false, message: 'No sequence available' };
    }

    if (selectedClipIds.length === 0) {
      return { success: false, message: 'No clips selected' };
    }

    // Find the end of the latest selected clip
    let latestEnd = 0;
    for (const clipId of selectedClipIds) {
      const found = findClipInSequence(sequence, clipId);
      if (found) {
        const clipEnd = found.clip.place.timelineInSec + getClipDuration(found.clip);
        if (clipEnd > latestEnd) {
          latestEnd = clipEnd;
        }
      }
    }

    onDuplicate?.(selectedClipIds, latestEnd);

    return {
      success: true,
      message: `Duplicated ${selectedClipIds.length} clip(s)`,
      clipIds: selectedClipIds,
    };
  }, [sequence, selectedClipIds, onDuplicate]);

  return {
    hasClipboard,
    clipboardCount,
    canCopy,
    canPaste,
    canCut,
    canDuplicate,
    copy,
    cut,
    paste,
    duplicate,
    clearClipboard,
  };
}

export default useClipboard;

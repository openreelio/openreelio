/**
 * useEnhancedKeyboardShortcuts Hook
 *
 * Comprehensive keyboard shortcut handler with extended functionality.
 * Includes tool switching, seek by seconds, copy/paste, and more.
 *
 * @module hooks/useEnhancedKeyboardShortcuts
 */

import { useEffect, useCallback, useRef } from 'react';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { useEditorToolStore, type EditorTool, type ClipboardItem } from '@/stores/editorToolStore';
import { PLAYBACK } from '@/constants/preview';
import type { Sequence, Clip } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface ClipSplitData {
  sequenceId: string;
  trackId: string;
  clipId: string;
  splitTime: number;
  keepLeft?: boolean;
  keepRight?: boolean;
}

export interface ClipDuplicateData {
  sequenceId: string;
  trackId: string;
  clipId: string;
  newTimelineIn: number;
}

export interface ClipPasteData {
  sequenceId: string;
  trackId: string;
  clipData: ClipboardItem['clipData'];
  pasteTime: number;
}

export interface UseEnhancedKeyboardShortcutsOptions {
  /** Current sequence data */
  sequence: Sequence | null;
  /** Callback for undo */
  onUndo?: () => void;
  /** Callback for redo */
  onRedo?: () => void;
  /** Callback for save */
  onSave?: () => void;
  /** Callback for delete clips */
  onDeleteClips?: (clipIds: string[]) => void;
  /** Callback for split clip */
  onClipSplit?: (data: ClipSplitData) => void;
  /** Callback for duplicate clip */
  onClipDuplicate?: (data: ClipDuplicateData) => void;
  /** Callback for paste clip */
  onClipPaste?: (data: ClipPasteData) => void;
  /** Callback for export */
  onExport?: () => void;
  /** Whether shortcuts are enabled */
  enabled?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Shuttle speed levels (Industry Standard - Avid/Premiere) */
const SHUTTLE_SPEEDS = [-8, -4, -2, -1, 0, 1, 2, 4, 8];
const STOP_INDEX = 4;

/** Seek amounts in seconds */
const SEEK_AMOUNT_SMALL = 1;
const SEEK_AMOUNT_LARGE = 5;

/** Tool keyboard mappings */
const TOOL_KEYS: Record<string, EditorTool> = {
  v: 'select',
  c: 'razor',
  b: 'ripple',
  y: 'slip',
  u: 'slide',
  n: 'roll',
  h: 'hand',
};

// =============================================================================
// Helper Functions
// =============================================================================

function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable ||
    target.contentEditable === 'true'
  );
}

function findClipInSequence(
  sequence: Sequence | null,
  clipId: string
): { clip: Clip; trackId: string } | null {
  if (!sequence) return null;
  for (const track of sequence.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      return { clip, trackId: track.id };
    }
  }
  return null;
}

function getClipDuration(clip: Clip): number {
  return (clip.range.sourceOutSec - clip.range.sourceInSec) / clip.speed;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Enhanced keyboard shortcuts hook with professional NLE features.
 *
 * Features:
 * - J/K/L shuttle control
 * - Tool switching (V, C, B, etc.)
 * - Seek by seconds (Left/Right + Shift)
 * - Jump by 5 seconds (Up/Down)
 * - Copy/Paste/Duplicate
 * - Split left/right
 * - Select all
 */
export function useEnhancedKeyboardShortcuts(
  options: UseEnhancedKeyboardShortcutsOptions
): void {
  const {
    sequence,
    onUndo,
    onRedo,
    onSave,
    onDeleteClips,
    onClipSplit,
    onClipDuplicate,
    onClipPaste,
    onExport,
    enabled = true,
  } = options;

  // Refs for state that shouldn't cause re-renders
  const shuttleIndexRef = useRef(STOP_INDEX);
  const sequenceRef = useRef(sequence);

  // Update sequence ref
  useEffect(() => {
    sequenceRef.current = sequence;
  }, [sequence]);

  // Store state
  const {
    togglePlayback,
    setCurrentTime,
    currentTime,
    duration,
    setPlaybackRate,
    play,
    pause,
    isPlaying,
    stepForward,
    stepBackward,
    seekForward,
    seekBackward,
  } = usePlaybackStore();

  const {
    zoomIn,
    zoomOut,
    selectedClipIds,
    clearClipSelection,
    selectClips,
    scrollToPlayhead,
  } = useTimelineStore();

  const {
    undo,
    redo,
    saveProject,
    isLoaded,
  } = useProjectStore();

  const {
    setActiveTool,
    toggleRipple,
    toggleAutoScroll,
    copyToClipboard,
    getClipboard,
  } = useEditorToolStore();

  // Track held keys for temporary tool switching
  const heldKeysRef = useRef<Set<string>>(new Set());

  // Reset shuttle index when playback stops
  useEffect(() => {
    if (!isPlaying) {
      shuttleIndexRef.current = STOP_INDEX;
    }
  }, [isPlaying]);

  /**
   * Handle copying selected clips to clipboard
   */
  const handleCopy = useCallback(() => {
    if (selectedClipIds.length === 0 || !sequenceRef.current) return;

    const items: ClipboardItem[] = [];
    for (const clipId of selectedClipIds) {
      const result = findClipInSequence(sequenceRef.current, clipId);
      if (result) {
        const { clip, trackId } = result;
        items.push({
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
        });
      }
    }

    if (items.length > 0) {
      copyToClipboard(items);
    }
  }, [selectedClipIds, copyToClipboard]);

  /**
   * Handle pasting clips from clipboard
   */
  const handlePaste = useCallback(() => {
    const clipboard = getClipboard();
    if (!clipboard || clipboard.length === 0 || !sequenceRef.current) return;
    if (!onClipPaste) return;

    for (const item of clipboard) {
      onClipPaste({
        sequenceId: sequenceRef.current.id,
        trackId: item.trackId,
        clipData: item.clipData,
        pasteTime: currentTime,
      });
    }
  }, [getClipboard, onClipPaste, currentTime]);

  /**
   * Handle duplicating selected clips
   */
  const handleDuplicate = useCallback(() => {
    if (selectedClipIds.length === 0 || !sequenceRef.current || !onClipDuplicate) return;

    for (const clipId of selectedClipIds) {
      const result = findClipInSequence(sequenceRef.current, clipId);
      if (result) {
        const { clip, trackId } = result;
        const clipDuration = getClipDuration(clip);
        const newTimelineIn = clip.place.timelineInSec + clipDuration;

        onClipDuplicate({
          sequenceId: sequenceRef.current.id,
          trackId,
          clipId,
          newTimelineIn,
        });
      }
    }
  }, [selectedClipIds, onClipDuplicate]);

  /**
   * Handle split at playhead with optional keep direction
   */
  const handleSplit = useCallback(
    (keepLeft?: boolean, keepRight?: boolean) => {
      if (selectedClipIds.length === 0 || !sequenceRef.current || !onClipSplit) return;

      for (const clipId of selectedClipIds) {
        const result = findClipInSequence(sequenceRef.current, clipId);
        if (!result) continue;

        const { clip, trackId } = result;
        const clipEnd = clip.place.timelineInSec + getClipDuration(clip);

        // Only split if playhead is within the clip
        if (currentTime > clip.place.timelineInSec && currentTime < clipEnd) {
          onClipSplit({
            sequenceId: sequenceRef.current.id,
            trackId,
            clipId,
            splitTime: currentTime,
            keepLeft,
            keepRight,
          });
        }
      }
    },
    [selectedClipIds, onClipSplit, currentTime]
  );

  /**
   * Handle select all clips
   */
  const handleSelectAll = useCallback(() => {
    if (!sequenceRef.current) return;
    const allClipIds = sequenceRef.current.tracks.flatMap((track) =>
      track.clips.map((clip) => clip.id)
    );
    selectClips(allClipIds);
  }, [selectClips]);

  /**
   * Main keydown handler
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Safety checks
      if (!enabled || isInputElement(e.target)) return;

      const { key, ctrlKey, metaKey, shiftKey, altKey, repeat } = e;
      const ctrl = ctrlKey || metaKey;
      const keyLower = key.toLowerCase();

      // Track held key for temporary tool switching
      heldKeysRef.current.add(keyLower);

      // -----------------------------------------------------------------------
      // Tool Switching (single key press, no modifiers)
      // -----------------------------------------------------------------------
      if (!ctrl && !shiftKey && !altKey && TOOL_KEYS[keyLower]) {
        e.preventDefault();
        setActiveTool(TOOL_KEYS[keyLower]);
        return;
      }

      // -----------------------------------------------------------------------
      // Transport Controls (J/K/L) - Skip repeat events
      // -----------------------------------------------------------------------
      if (repeat) return;

      // J - Reverse
      if (keyLower === 'j' && !ctrl && !shiftKey && !altKey) {
        e.preventDefault();
        if (shuttleIndexRef.current > 0) {
          shuttleIndexRef.current--;
          const speed = SHUTTLE_SPEEDS[shuttleIndexRef.current];
          if (speed === 0) {
            pause();
            setPlaybackRate(1);
          } else {
            play();
            setPlaybackRate(speed);
          }
        }
        return;
      }

      // K - Stop
      if (keyLower === 'k' && !ctrl && !shiftKey && !altKey) {
        e.preventDefault();
        shuttleIndexRef.current = STOP_INDEX;
        pause();
        setPlaybackRate(1);
        return;
      }

      // L - Forward
      if (keyLower === 'l' && !ctrl && !shiftKey && !altKey) {
        e.preventDefault();
        if (shuttleIndexRef.current < SHUTTLE_SPEEDS.length - 1) {
          shuttleIndexRef.current++;
          const speed = SHUTTLE_SPEEDS[shuttleIndexRef.current];
          if (speed === 0) {
            pause();
            setPlaybackRate(1);
          } else {
            play();
            setPlaybackRate(speed);
          }
        }
        return;
      }

      // Space - Toggle playback
      if (key === ' ' && !ctrl && !shiftKey && !altKey) {
        e.preventDefault();
        togglePlayback();
        shuttleIndexRef.current = STOP_INDEX;
        setPlaybackRate(1);
        return;
      }

      // -----------------------------------------------------------------------
      // Navigation
      // -----------------------------------------------------------------------

      // Arrow Left - Frame step or seek 1 second (with Shift)
      if (key === 'ArrowLeft' && !ctrl && !altKey) {
        e.preventDefault();
        if (shiftKey) {
          seekBackward(SEEK_AMOUNT_SMALL);
        } else {
          stepBackward(PLAYBACK.TARGET_FPS);
        }
        return;
      }

      // Arrow Right - Frame step or seek 1 second (with Shift)
      if (key === 'ArrowRight' && !ctrl && !altKey) {
        e.preventDefault();
        if (shiftKey) {
          seekForward(SEEK_AMOUNT_SMALL);
        } else {
          stepForward(PLAYBACK.TARGET_FPS);
        }
        return;
      }

      // Arrow Up - Jump 5 seconds backward
      if (key === 'ArrowUp' && !ctrl && !altKey) {
        e.preventDefault();
        seekBackward(SEEK_AMOUNT_LARGE);
        return;
      }

      // Arrow Down - Jump 5 seconds forward
      if (key === 'ArrowDown' && !ctrl && !altKey) {
        e.preventDefault();
        seekForward(SEEK_AMOUNT_LARGE);
        return;
      }

      // Home - Go to start
      if (key === 'Home') {
        e.preventDefault();
        setCurrentTime(0);
        return;
      }

      // End - Go to end
      if (key === 'End') {
        e.preventDefault();
        setCurrentTime(duration);
        return;
      }

      // -----------------------------------------------------------------------
      // View Controls
      // -----------------------------------------------------------------------

      // Ctrl+= or Ctrl++ - Zoom in
      if ((key === '=' || key === '+') && ctrl) {
        e.preventDefault();
        zoomIn();
        return;
      }

      // Ctrl+- - Zoom out
      if (key === '-' && ctrl) {
        e.preventDefault();
        zoomOut();
        return;
      }

      // F - Scroll to playhead (fit playhead in view)
      if (keyLower === 'f' && !ctrl && !shiftKey && !altKey) {
        e.preventDefault();
        scrollToPlayhead(800); // Use default viewport width
        return;
      }

      // -----------------------------------------------------------------------
      // Edit Actions
      // -----------------------------------------------------------------------

      // Ctrl+Z - Undo
      if (keyLower === 'z' && ctrl && !shiftKey) {
        e.preventDefault();
        if (onUndo) onUndo();
        else if (isLoaded) void undo();
        return;
      }

      // Ctrl+Shift+Z or Ctrl+Y - Redo
      if ((keyLower === 'z' && ctrl && shiftKey) || (keyLower === 'y' && ctrl)) {
        e.preventDefault();
        if (onRedo) onRedo();
        else if (isLoaded) void redo();
        return;
      }

      // Ctrl+S - Save
      if (keyLower === 's' && ctrl && !shiftKey) {
        e.preventDefault();
        if (onSave) onSave();
        else if (isLoaded) void saveProject();
        return;
      }

      // Ctrl+C - Copy
      if (keyLower === 'c' && ctrl && !shiftKey) {
        e.preventDefault();
        handleCopy();
        return;
      }

      // Ctrl+V - Paste
      if (keyLower === 'v' && ctrl && !shiftKey) {
        e.preventDefault();
        handlePaste();
        return;
      }

      // Ctrl+D - Duplicate
      if (keyLower === 'd' && ctrl && !shiftKey) {
        e.preventDefault();
        handleDuplicate();
        return;
      }

      // Ctrl+A - Select all
      if (keyLower === 'a' && ctrl && !shiftKey) {
        e.preventDefault();
        handleSelectAll();
        return;
      }

      // Delete/Backspace - Delete selected
      if ((key === 'Delete' || key === 'Backspace') && !ctrl) {
        if (selectedClipIds.length > 0 && onDeleteClips) {
          e.preventDefault();
          onDeleteClips(selectedClipIds);
        }
        return;
      }

      // S - Split at playhead
      if (keyLower === 's' && !ctrl && !altKey) {
        if (selectedClipIds.length > 0) {
          e.preventDefault();
          if (shiftKey) {
            // Shift+S - Split and keep right
            handleSplit(false, true);
          } else {
            // S - Normal split
            handleSplit();
          }
        }
        return;
      }

      // Q - Split and keep left
      if (keyLower === 'q' && !ctrl && !shiftKey && !altKey) {
        if (selectedClipIds.length > 0) {
          e.preventDefault();
          handleSplit(true, false);
        }
        return;
      }

      // W - Split and keep right
      if (keyLower === 'w' && !ctrl && !shiftKey && !altKey) {
        if (selectedClipIds.length > 0) {
          e.preventDefault();
          handleSplit(false, true);
        }
        return;
      }

      // Escape - Deselect all
      if (key === 'Escape') {
        e.preventDefault();
        clearClipSelection();
        setActiveTool('select'); // Reset to selection tool
        return;
      }

      // Ctrl+Shift+E - Export
      if (keyLower === 'e' && ctrl && shiftKey) {
        e.preventDefault();
        if (onExport) onExport();
        return;
      }

      // R - Toggle ripple editing
      if (keyLower === 'r' && !ctrl && !shiftKey && !altKey) {
        e.preventDefault();
        toggleRipple();
        return;
      }

      // Shift+F - Toggle auto-scroll
      if (keyLower === 'f' && shiftKey && !ctrl && !altKey) {
        e.preventDefault();
        toggleAutoScroll();
        return;
      }
    },
    [
      enabled,
      togglePlayback,
      setCurrentTime,
      duration,
      setPlaybackRate,
      play,
      pause,
      stepForward,
      stepBackward,
      seekForward,
      seekBackward,
      zoomIn,
      zoomOut,
      selectedClipIds,
      clearClipSelection,
      scrollToPlayhead,
      isLoaded,
      undo,
      redo,
      saveProject,
      setActiveTool,
      toggleRipple,
      toggleAutoScroll,
      handleCopy,
      handlePaste,
      handleDuplicate,
      handleSplit,
      handleSelectAll,
      onUndo,
      onRedo,
      onSave,
      onDeleteClips,
      onExport,
    ]
  );

  /**
   * Keyup handler for temporary tool switching
   */
  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      const keyLower = e.key.toLowerCase();
      heldKeysRef.current.delete(keyLower);

      // If a tool key was released, check if we should pop back to previous tool
      if (TOOL_KEYS[keyLower]) {
        // This would be for temporary tool switching (hold key behavior)
        // Currently not implemented - reserved for future use
      }
    },
    []
  );

  // Register event listeners
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);
}

// =============================================================================
// Shortcuts Reference
// =============================================================================

export const ENHANCED_KEYBOARD_SHORTCUTS = [
  {
    category: 'Transport',
    shortcuts: [
      { key: 'Space', description: 'Play/Pause' },
      { key: 'J', description: 'Shuttle Reverse' },
      { key: 'K', description: 'Stop' },
      { key: 'L', description: 'Shuttle Forward' },
      { key: 'Left', description: 'Previous Frame' },
      { key: 'Right', description: 'Next Frame' },
      { key: 'Shift+Left', description: 'Seek 1 second back' },
      { key: 'Shift+Right', description: 'Seek 1 second forward' },
      { key: 'Up', description: 'Jump 5 seconds back' },
      { key: 'Down', description: 'Jump 5 seconds forward' },
      { key: 'Home', description: 'Go to start' },
      { key: 'End', description: 'Go to end' },
    ],
  },
  {
    category: 'Tools',
    shortcuts: [
      { key: 'V', description: 'Selection Tool' },
      { key: 'C', description: 'Razor/Cut Tool' },
      { key: 'B', description: 'Ripple Edit Tool' },
      { key: 'Y', description: 'Slip Tool' },
      { key: 'U', description: 'Slide Tool' },
      { key: 'N', description: 'Roll Tool' },
      { key: 'H', description: 'Hand/Pan Tool' },
    ],
  },
  {
    category: 'Editing',
    shortcuts: [
      { key: 'Ctrl+Z', description: 'Undo' },
      { key: 'Ctrl+Shift+Z', description: 'Redo' },
      { key: 'Ctrl+S', description: 'Save' },
      { key: 'Ctrl+C', description: 'Copy' },
      { key: 'Ctrl+V', description: 'Paste' },
      { key: 'Ctrl+D', description: 'Duplicate' },
      { key: 'Ctrl+A', description: 'Select All' },
      { key: 'S', description: 'Split at Playhead' },
      { key: 'Q', description: 'Split and Keep Left' },
      { key: 'W', description: 'Split and Keep Right' },
      { key: 'Delete', description: 'Delete Selected' },
      { key: 'Esc', description: 'Deselect All' },
    ],
  },
  {
    category: 'View',
    shortcuts: [
      { key: 'Ctrl++', description: 'Zoom In' },
      { key: 'Ctrl+-', description: 'Zoom Out' },
      { key: 'F', description: 'Scroll to Playhead' },
      { key: 'Shift+F', description: 'Toggle Auto-Follow' },
      { key: 'R', description: 'Toggle Ripple Editing' },
    ],
  },
  {
    category: 'Export',
    shortcuts: [
      { key: 'Ctrl+Shift+E', description: 'Export' },
    ],
  },
];

export default useEnhancedKeyboardShortcuts;

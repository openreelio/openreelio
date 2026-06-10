/**
 * useKeyboardShortcuts Hook
 *
 * Global keyboard shortcut handler for the application.
 * Delegates J/K/L Shuttle control to useJKLShuttle and handles standard NLE shortcuts.
 */

import { useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { useJKLShuttle } from './useJKLShuttle';
import { PLAYBACK } from '@/constants/preview';
import { isInputElement } from '@/utils/dom';

// =============================================================================
// Types
// =============================================================================

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
  action: () => void;
}

export interface UseKeyboardShortcutsOptions {
  onUndo?: () => void;
  onRedo?: () => void;
  onSave?: () => void;
  onDeleteClips?: () => void;
  onSplitAtPlayhead?: () => void;
  onExport?: () => void;
  onMatchFrame?: () => void;
  onReverseMatchFrame?: () => void;
  onRevealSourceClip?: () => void;
  onToggleLoopRange?: () => void;
  onPlayAroundEdit?: () => void;
  onToggleClipEnabled?: () => void;
  onToggleColorComparison?: () => void;
  onCopyEffects?: () => void;
  onPasteEffects?: () => void;
  onPasteAttributes?: () => void;
  onLinkClips?: () => void;
  onUnlinkClips?: () => void;
  onGroupClips?: () => void;
  onUngroupClips?: () => void;
  onToggleCommandPalette?: () => void;
  onToggleFullscreen?: () => void;
  onCaptureSnapshot?: () => void;
  enabled?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** IPC command names for edit point / marker navigation */
const NAV_COMMANDS = {
  NEXT_EDIT_POINT: 'get_next_edit_point',
  PREV_EDIT_POINT: 'get_prev_edit_point',
  NEXT_MARKER: 'get_next_marker',
  PREV_MARKER: 'get_prev_marker',
} as const;

type NavCommand = (typeof NAV_COMMANDS)[keyof typeof NAV_COMMANDS];

// =============================================================================
// Hook
// =============================================================================

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions = {}): void {
  const {
    onUndo,
    onRedo,
    onSave,
    onDeleteClips,
    onSplitAtPlayhead,
    onExport,
    onMatchFrame,
    onReverseMatchFrame,
    onRevealSourceClip,
    onToggleLoopRange,
    onPlayAroundEdit,
    onToggleClipEnabled,
    onToggleColorComparison,
    onCopyEffects,
    onPasteEffects,
    onPasteAttributes,
    onLinkClips,
    onUnlinkClips,
    onGroupClips,
    onUngroupClips,
    onToggleCommandPalette,
    onToggleFullscreen,
    onCaptureSnapshot,
    enabled = true,
  } = options;

  // Store actions - Zustand store functions are stable and don't change
  const {
    togglePlayback,
    seek,
    setPlaybackRate,
    play,
    pause,
    isPlaying,
    duration,
    stepForward,
    stepBackward,
    seekForward,
    seekBackward,
    setShuttleSpeed,
  } = usePlaybackStore();

  const { zoomIn, zoomOut, selectedClipIds, clearClipSelection } = useTimelineStore();
  const { undo, redo, saveProject, isLoaded, activeSequenceId } = useProjectStore();

  // Stable callbacks for shuttle (avoid recreating interval on parent re-render)
  const shuttleStepFwd = useCallback(() => stepForward(PLAYBACK.TARGET_FPS), [stepForward]);
  const shuttleStepBwd = useCallback(() => stepBackward(PLAYBACK.TARGET_FPS), [stepBackward]);
  const shuttleSeekRelative = useCallback(
    (delta: number) => {
      if (delta < 0) {
        seekBackward(-delta, 'shuttle-reverse');
      } else {
        seekForward(delta, 'shuttle-forward');
      }
    },
    [seekForward, seekBackward],
  );

  // JKL Shuttle hook — delegates all shuttle logic
  const shuttle = useJKLShuttle({
    play,
    pause,
    setPlaybackRate,
    stepForward: shuttleStepFwd,
    stepBackward: shuttleStepBwd,
    seekRelative: shuttleSeekRelative,
    enabled,
  });

  // Destructure stable callbacks to avoid depending on the full shuttle object
  const {
    handleKeyDown: shuttleKeyDown,
    resetShuttle,
    handleKeyUp: shuttleKeyUp,
    shuttleSpeed,
  } = shuttle;

  // Sync shuttle speed to playbackStore for UI indicator access
  useEffect(() => {
    setShuttleSpeed(shuttleSpeed);
  }, [shuttleSpeed, setShuttleSpeed]);

  // Reset shuttle only when playback stops externally.
  // Reverse shuttle intentionally pauses native playback while keeping shuttle active.
  const previousIsPlayingRef = useRef(isPlaying);
  useEffect(() => {
    if (previousIsPlayingRef.current && !isPlaying && shuttleSpeed >= 0) {
      resetShuttle();
    }
    previousIsPlayingRef.current = isPlaying;
  }, [isPlaying, shuttleSpeed, resetShuttle]);

  // Use refs for frequently-changing state values to avoid recreating the callback
  const selectedClipIdsRef = useRef(selectedClipIds);
  const isLoadedRef = useRef(isLoaded);
  const activeSequenceIdRef = useRef(activeSequenceId);
  const durationRef = useRef(duration);

  useEffect(() => {
    selectedClipIdsRef.current = selectedClipIds;
  }, [selectedClipIds]);

  useEffect(() => {
    isLoadedRef.current = isLoaded;
  }, [isLoaded]);

  useEffect(() => {
    activeSequenceIdRef.current = activeSequenceId;
  }, [activeSequenceId]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  // Helper: navigate to an edit point or marker via IPC
  const navigateToPoint = useCallback(
    (command: NavCommand) => {
      const seqId = activeSequenceIdRef.current;
      if (!seqId) return;
      const currentTime = usePlaybackStore.getState().currentTime;
      void invoke<number | null>(command, { sequenceId: seqId, currentTime })
        .then((time) => {
          if (time !== null) seek(time);
        })
        .catch(() => {
          // Navigation IPC failed — no user-facing impact
        });
    },
    [seek],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Safety checks
      if (!enabled) return;
      if (e.repeat) return;

      const { key, ctrlKey, metaKey, shiftKey } = e;
      const ctrl = ctrlKey || metaKey;

      // Respect handlers on focused feature surfaces to avoid duplicate execution
      if (e.defaultPrevented) {
        if (!ctrlKey && !metaKey && !shiftKey && !e.altKey && key === ' ') {
          resetShuttle();
        }
        return;
      }

      // Command Palette should remain globally accessible even when focus is in an input.
      if (key.toLowerCase() === 'p' && ctrl && shiftKey) {
        if (onToggleCommandPalette) {
          e.preventDefault();
          onToggleCommandPalette();
        }
        return;
      }

      if (isInputElement(e.target)) return;

      // -----------------------------------------------------------------------
      // Transport Controls (J/K/L) — delegated to useJKLShuttle
      // -----------------------------------------------------------------------
      if (shuttleKeyDown(key, ctrl, shiftKey)) {
        e.preventDefault();
        return;
      }

      // Fullscreen toggle (backtick)
      if (key === '`' && !ctrl && !shiftKey) {
        e.preventDefault();
        if (onToggleFullscreen) onToggleFullscreen();
        return;
      }

      // Space - Toggle (resets shuttle)
      if (key === ' ' && !ctrl && !shiftKey) {
        e.preventDefault();
        togglePlayback();
        resetShuttle();
        return;
      }

      if (key === ' ' && !ctrl && shiftKey) {
        if (onPlayAroundEdit) {
          e.preventDefault();
          onPlayAroundEdit();
        }
        return;
      }

      // -----------------------------------------------------------------------
      // Navigation
      // -----------------------------------------------------------------------

      if (key === 'ArrowLeft' && !ctrl && !shiftKey) {
        e.preventDefault();
        stepBackward(PLAYBACK.TARGET_FPS);
        return;
      }

      if (key === 'ArrowRight' && !ctrl && !shiftKey) {
        e.preventDefault();
        stepForward(PLAYBACK.TARGET_FPS);
        return;
      }

      // Up/Down Arrow — edit point navigation (S27-002)
      if (key === 'ArrowUp' && !ctrl && !shiftKey) {
        e.preventDefault();
        navigateToPoint(NAV_COMMANDS.PREV_EDIT_POINT);
        return;
      }

      if (key === 'ArrowDown' && !ctrl && !shiftKey) {
        e.preventDefault();
        navigateToPoint(NAV_COMMANDS.NEXT_EDIT_POINT);
        return;
      }

      // Shift+Up/Down — marker navigation (S27-002)
      if (key === 'ArrowUp' && !ctrl && shiftKey) {
        e.preventDefault();
        navigateToPoint(NAV_COMMANDS.PREV_MARKER);
        return;
      }

      if (key === 'ArrowDown' && !ctrl && shiftKey) {
        e.preventDefault();
        navigateToPoint(NAV_COMMANDS.NEXT_MARKER);
        return;
      }

      if (key === 'Home') {
        e.preventDefault();
        seek(0);
        return;
      }

      if (key === 'End') {
        e.preventDefault();
        seek(durationRef.current);
        return;
      }

      // -----------------------------------------------------------------------
      // View Controls
      // -----------------------------------------------------------------------

      if ((key === '=' || key === '+') && ctrl) {
        e.preventDefault();
        zoomIn();
        return;
      }

      if (key === '-' && ctrl) {
        e.preventDefault();
        zoomOut();
        return;
      }

      // -----------------------------------------------------------------------
      // Edit Actions
      // -----------------------------------------------------------------------

      // Undo
      if (key.toLowerCase() === 'z' && ctrl && !shiftKey) {
        e.preventDefault();
        if (onUndo) onUndo();
        else if (isLoadedRef.current) void undo();
        return;
      }

      // Redo
      if ((key.toLowerCase() === 'z' && ctrl && shiftKey) || (key.toLowerCase() === 'y' && ctrl)) {
        e.preventDefault();
        if (onRedo) onRedo();
        else if (isLoadedRef.current) void redo();
        return;
      }

      // Snapshot capture (Ctrl+Shift+S)
      if (key.toLowerCase() === 's' && ctrl && shiftKey) {
        e.preventDefault();
        if (onCaptureSnapshot) onCaptureSnapshot();
        return;
      }

      // Save
      if (key.toLowerCase() === 's' && ctrl && !shiftKey) {
        e.preventDefault();
        if (onSave) onSave();
        else if (isLoadedRef.current) void saveProject();
        return;
      }

      // Delete
      if ((key === 'Delete' || key === 'Backspace') && !ctrl) {
        if (selectedClipIdsRef.current.length > 0) {
          e.preventDefault();
          if (onDeleteClips) onDeleteClips();
        }
        return;
      }

      // Split (Blade)
      if (key.toLowerCase() === 's' && !ctrl && !shiftKey) {
        if (selectedClipIdsRef.current.length > 0 && onSplitAtPlayhead) {
          e.preventDefault();
          onSplitAtPlayhead();
        }
        return;
      }

      // Deselect
      if (key === 'Escape') {
        e.preventDefault();
        clearClipSelection();
        return;
      }

      // Match Frame (F) / Reverse Match Frame (Shift+F)
      if (key.toLowerCase() === 'f' && !ctrl && !e.altKey) {
        if (shiftKey && onReverseMatchFrame) {
          e.preventDefault();
          onReverseMatchFrame();
          return;
        }
        if (!shiftKey && onMatchFrame) {
          e.preventDefault();
          onMatchFrame();
          return;
        }
      }

      if (key.toLowerCase() === 'f' && !ctrl && e.altKey && !shiftKey) {
        if (onRevealSourceClip) {
          e.preventDefault();
          onRevealSourceClip();
        }
        return;
      }

      // Toggle Clip Enabled (Shift+E)
      if (key.toLowerCase() === 'e' && shiftKey && !ctrl && !e.altKey) {
        if (onToggleClipEnabled) {
          e.preventDefault();
          onToggleClipEnabled();
        }
        return; // Always return, even if callback is absent
      }

      // Toggle Color Comparison (Shift+D)
      if (key.toLowerCase() === 'd' && shiftKey && !ctrl && !e.altKey) {
        if (onToggleColorComparison) {
          e.preventDefault();
          onToggleColorComparison();
        }
        return;
      }

      // Copy Effects (Ctrl+Alt+C)
      if (key.toLowerCase() === 'c' && ctrl && e.altKey && !shiftKey) {
        e.preventDefault();
        if (onCopyEffects) onCopyEffects();
        return;
      }

      // Paste Effects (Ctrl+Alt+V)
      if (key.toLowerCase() === 'v' && ctrl && e.altKey && !shiftKey) {
        e.preventDefault();
        if (onPasteEffects) onPasteEffects();
        return;
      }

      // Paste Attributes (Ctrl+Alt+A)
      if (key.toLowerCase() === 'a' && ctrl && e.altKey && !shiftKey) {
        e.preventDefault();
        if (onPasteAttributes) onPasteAttributes();
        return;
      }

      // Link / Unlink selected clips (Ctrl+L / Ctrl+Shift+L)
      if (key.toLowerCase() === 'l' && ctrl && !e.altKey) {
        e.preventDefault();
        if (shiftKey) {
          if (onUnlinkClips) onUnlinkClips();
        } else if (onLinkClips) {
          onLinkClips();
        }
        return;
      }

      if (key.toLowerCase() === 'l' && !ctrl && e.altKey && !shiftKey) {
        if (onToggleLoopRange) {
          e.preventDefault();
          onToggleLoopRange();
        }
        return;
      }

      // Group / Ungroup selected clips (Ctrl+G / Ctrl+Shift+G)
      if (key.toLowerCase() === 'g' && ctrl && !e.altKey) {
        e.preventDefault();
        if (shiftKey) {
          if (onUngroupClips) onUngroupClips();
        } else if (onGroupClips) {
          onGroupClips();
        }
        return;
      }

      // Export
      if (key.toLowerCase() === 'e' && ctrl && shiftKey) {
        e.preventDefault();
        if (onExport) onExport();
        return;
      }
    },
    [
      enabled,
      shuttleKeyDown,
      resetShuttle,
      navigateToPoint,
      togglePlayback,
      seek,
      stepForward,
      stepBackward,
      zoomIn,
      zoomOut,
      clearClipSelection,
      onUndo,
      onRedo,
      onSave,
      onDeleteClips,
      onSplitAtPlayhead,
      onExport,
      onMatchFrame,
      onReverseMatchFrame,
      onRevealSourceClip,
      onToggleLoopRange,
      onPlayAroundEdit,
      onToggleClipEnabled,
      onToggleColorComparison,
      onCopyEffects,
      onPasteEffects,
      onPasteAttributes,
      onLinkClips,
      onUnlinkClips,
      onGroupClips,
      onUngroupClips,
      onToggleCommandPalette,
      onToggleFullscreen,
      onCaptureSnapshot,
      undo,
      redo,
      saveProject,
    ],
  );

  // Handle keyup for K release detection (K+J/K+L combo)
  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled || isInputElement(e.target)) return;
      shuttleKeyUp(e.key);
    },
    [enabled, shuttleKeyUp],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);
}

export const KEYBOARD_SHORTCUTS = [
  {
    category: 'Transport',
    shortcuts: [
      { key: 'Space', description: 'Play/Pause' },
      { key: 'J', description: 'Shuttle Reverse (-1x, -2x, -4x, -8x)' },
      { key: 'K', description: 'Stop' },
      { key: 'L', description: 'Shuttle Forward (1x, 2x, 4x, 8x)' },
      { key: 'K+J', description: 'Step One Frame Backward' },
      { key: 'K+L', description: 'Step One Frame Forward' },
      { key: 'Left', description: 'Previous Frame' },
      { key: 'Right', description: 'Next Frame' },
      { key: 'Up', description: 'Previous Edit Point' },
      { key: 'Down', description: 'Next Edit Point' },
      { key: 'Shift+Up', description: 'Previous Marker' },
      { key: 'Shift+Down', description: 'Next Marker' },
      { key: 'Home', description: 'Go to Timeline Start' },
      { key: 'End', description: 'Go to Timeline End' },
    ],
  },
  {
    category: 'Source Monitor',
    shortcuts: [
      { key: 'I', description: 'Set In Point' },
      { key: 'O', description: 'Set Out Point' },
      { key: 'Esc', description: 'Clear In/Out Points' },
      { key: 'F', description: 'Match Frame (Timeline → Source)' },
      { key: 'Shift+F', description: 'Reverse Match Frame (Source → Timeline)' },
    ],
  },
  {
    category: 'Editing',
    shortcuts: [
      { key: 'Ctrl+Z', description: 'Undo' },
      { key: 'Ctrl+Shift+Z', description: 'Redo' },
      { key: 'S', description: 'Split Clip' },
      { key: 'Delete', description: 'Delete Selected' },
      { key: 'Esc', description: 'Deselect All' },
      { key: 'Ctrl+Alt+C', description: 'Copy Effects' },
      { key: 'Ctrl+Alt+V', description: 'Paste Effects' },
      { key: 'Ctrl+Alt+A', description: 'Paste Attributes' },
      { key: 'Shift+E', description: 'Toggle Clip Enabled' },
      { key: 'Ctrl+L', description: 'Link Selected Clips' },
      { key: 'Ctrl+Shift+L', description: 'Unlink Selected Clips' },
      { key: 'Ctrl+G', description: 'Group Selected Clips' },
      { key: 'Ctrl+Shift+G', description: 'Ungroup Selected Clips' },
    ],
  },
  {
    category: 'Color',
    shortcuts: [{ key: 'Shift+D', description: 'Toggle Before/After Color Comparison' }],
  },
  {
    category: 'General',
    shortcuts: [
      { key: 'Ctrl+Shift+P', description: 'Command Palette' },
      { key: '`', description: 'Toggle Fullscreen Preview' },
      { key: 'Ctrl+Shift+S', description: 'Capture Preview Snapshot' },
    ],
  },
];

/**
 * useKeyboardShortcuts Hook
 *
 * Global keyboard shortcut handler for the application.
 * Implements J/K/L Shuttle control and standard NLE shortcuts.
 */

import { useEffect, useCallback, useRef } from 'react';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { PLAYBACK } from '@/constants/preview';

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
  enabled?: boolean;
}

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

// =============================================================================
// Constants
// =============================================================================

// Shuttle speed levels (Industry Standard - Avid/Premiere)
// Index 4 is 0 (stop)
const SHUTTLE_SPEEDS = [-8, -4, -2, -1, 0, 1, 2, 4, 8];
const STOP_INDEX = 4;

export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions = {}): void {
  const {
    onUndo,
    onRedo,
    onSave,
    onDeleteClips,
    onSplitAtPlayhead,
    onExport,
    enabled = true,
  } = options;

  // Use refs for state that updates frequently but shouldn't cause re-renders of the hook
  // This prevents the "stale closure" problem with the shuttle index
  const shuttleIndexRef = useRef(STOP_INDEX);

  // Store actions - Zustand store functions are stable and don't change
  const {
    togglePlayback,
    seek,
    duration,
    setPlaybackRate,
    play,
    pause,
    isPlaying,
    stepForward,
    stepBackward,
  } = usePlaybackStore();

  const { zoomIn, zoomOut, selectedClipIds, clearClipSelection } = useTimelineStore();
  const { undo, redo, saveProject, isLoaded } = useProjectStore();

  // Use refs for frequently-changing state values to avoid recreating the callback
  // This significantly reduces re-renders when selection changes
  const selectedClipIdsRef = useRef(selectedClipIds);
  const isLoadedRef = useRef(isLoaded);
  const durationRef = useRef(duration);

  // Keep refs up to date (cheap updates, don't cause callback recreation)
  useEffect(() => {
    selectedClipIdsRef.current = selectedClipIds;
  }, [selectedClipIds]);

  useEffect(() => {
    isLoadedRef.current = isLoaded;
  }, [isLoaded]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  // Reset shuttle index when playback state changes externally (e.g. hitting stop button in UI)
  useEffect(() => {
    if (!isPlaying) {
      shuttleIndexRef.current = STOP_INDEX;
    }
  }, [isPlaying]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // 1. Safety Checks
      if (!enabled || isInputElement(e.target)) return;
      if (e.repeat) return; // Prevent holding key down from triggering logic repeatedly (optional)

      const { key, ctrlKey, metaKey, shiftKey } = e;
      const ctrl = ctrlKey || metaKey;

      // -----------------------------------------------------------------------
      // Transport Controls (J/K/L)
      // -----------------------------------------------------------------------

      // J - Reverse
      if (key.toLowerCase() === 'j' && !ctrl && !shiftKey) {
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
      if (key.toLowerCase() === 'k' && !ctrl && !shiftKey) {
        e.preventDefault();
        shuttleIndexRef.current = STOP_INDEX;
        pause();
        setPlaybackRate(1);
        return;
      }

      // L - Forward
      if (key.toLowerCase() === 'l' && !ctrl && !shiftKey) {
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

      // Space - Toggle
      if (key === ' ' && !ctrl && !shiftKey) {
        e.preventDefault();
        togglePlayback();
        shuttleIndexRef.current = STOP_INDEX; // Reset shuttle on manual toggle
        setPlaybackRate(1);
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

      // Export
      if (key.toLowerCase() === 'e' && ctrl && shiftKey) {
        e.preventDefault();
        if (onExport) onExport();
        return;
      }
    },
    // Dependencies optimized: frequently-changing values (selectedClipIds, duration, isLoaded)
    // are accessed via refs to prevent unnecessary callback recreation.
    // Store functions (togglePlayback, play, pause, etc.) are stable and don't change.
    [
      enabled,
      togglePlayback,
      seek,
      setPlaybackRate,
      play,
      pause,
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
      undo,
      redo,
      saveProject,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}

export const KEYBOARD_SHORTCUTS = [
  {
    category: 'Transport',
    shortcuts: [
      { key: 'Space', description: 'Play/Pause' },
      { key: 'J', description: 'Shuttle Reverse (Speed -1x, -2x, -4x...)' },
      { key: 'K', description: 'Stop' },
      { key: 'L', description: 'Shuttle Forward (Speed 1x, 2x, 4x...)' },
      { key: 'Left', description: 'Previous Frame' },
      { key: 'Right', description: 'Next Frame' },
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
    ],
  },
];

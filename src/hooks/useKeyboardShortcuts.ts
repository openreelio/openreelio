/**
 * useKeyboardShortcuts Hook
 *
 * Global keyboard shortcut handler for the application.
 */

import { useEffect, useCallback } from 'react';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useProjectStore } from '@/stores/projectStore';

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
  /** Callback for undo action */
  onUndo?: () => void;
  /** Callback for redo action */
  onRedo?: () => void;
  /** Callback for save action */
  onSave?: () => void;
  /** Callback for delete selected clips */
  onDeleteClips?: () => void;
  /** Callback for split at playhead */
  onSplitAtPlayhead?: () => void;
  /** Callback for export dialog */
  onExport?: () => void;
  /** Whether shortcuts are enabled */
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
    enabled = true,
  } = options;

  // Get store actions
  const { togglePlayback, setCurrentTime, currentTime, duration } = usePlaybackStore();
  const { zoomIn, zoomOut, selectedClipIds, clearClipSelection } = useTimelineStore();
  const { undo, redo, saveProject, isLoaded } = useProjectStore();

  // Handle keydown
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle if disabled or in input element
      if (!enabled || isInputElement(e.target)) return;

      const { key, ctrlKey, metaKey, shiftKey } = e;
      const ctrl = ctrlKey || metaKey;

      // Playback shortcuts
      if (key === ' ' && !ctrl && !shiftKey) {
        e.preventDefault();
        togglePlayback();
        return;
      }

      // Frame step with arrow keys
      if (key === 'ArrowLeft' && !ctrl && !shiftKey) {
        e.preventDefault();
        setCurrentTime(Math.max(0, currentTime - 1 / 30)); // Step back one frame (30fps)
        return;
      }

      if (key === 'ArrowRight' && !ctrl && !shiftKey) {
        e.preventDefault();
        setCurrentTime(Math.min(duration, currentTime + 1 / 30)); // Step forward one frame
        return;
      }

      // Jump to start/end
      if (key === 'Home') {
        e.preventDefault();
        setCurrentTime(0);
        return;
      }

      if (key === 'End') {
        e.preventDefault();
        setCurrentTime(duration);
        return;
      }

      // Zoom shortcuts
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

      // Undo/Redo
      if (key === 'z' && ctrl && !shiftKey) {
        e.preventDefault();
        if (onUndo) {
          onUndo();
        } else if (isLoaded) {
          void undo();
        }
        return;
      }

      if ((key === 'z' && ctrl && shiftKey) || (key === 'y' && ctrl)) {
        e.preventDefault();
        if (onRedo) {
          onRedo();
        } else if (isLoaded) {
          void redo();
        }
        return;
      }

      // Save
      if (key === 's' && ctrl && !shiftKey) {
        e.preventDefault();
        if (onSave) {
          onSave();
        } else if (isLoaded) {
          void saveProject();
        }
        return;
      }

      // Delete
      if ((key === 'Delete' || key === 'Backspace') && !ctrl) {
        if (selectedClipIds.length > 0) {
          e.preventDefault();
          if (onDeleteClips) {
            onDeleteClips();
          }
        }
        return;
      }

      // Split at playhead
      if (key === 's' && !ctrl && !shiftKey) {
        if (selectedClipIds.length > 0 && onSplitAtPlayhead) {
          e.preventDefault();
          onSplitAtPlayhead();
        }
        return;
      }

      // Escape to deselect
      if (key === 'Escape') {
        e.preventDefault();
        clearClipSelection();
        return;
      }

      // Export
      if (key === 'e' && ctrl && shiftKey) {
        e.preventDefault();
        if (onExport) {
          onExport();
        }
        return;
      }
    },
    [
      enabled,
      togglePlayback,
      setCurrentTime,
      currentTime,
      duration,
      zoomIn,
      zoomOut,
      selectedClipIds,
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
      isLoaded,
    ]
  );

  // Register global listener
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}

// =============================================================================
// Shortcut List (for documentation/help)
// =============================================================================

export const KEYBOARD_SHORTCUTS: { key: string; description: string }[] = [
  { key: 'Space', description: 'Play/Pause' },
  { key: 'Left Arrow', description: 'Step back one frame' },
  { key: 'Right Arrow', description: 'Step forward one frame' },
  { key: 'Home', description: 'Jump to start' },
  { key: 'End', description: 'Jump to end' },
  { key: 'Ctrl + Z', description: 'Undo' },
  { key: 'Ctrl + Shift + Z', description: 'Redo' },
  { key: 'Ctrl + S', description: 'Save project' },
  { key: 'Ctrl + +', description: 'Zoom in' },
  { key: 'Ctrl + -', description: 'Zoom out' },
  { key: 'Delete', description: 'Delete selected clips' },
  { key: 'S', description: 'Split clip at playhead' },
  { key: 'Escape', description: 'Deselect all' },
  { key: 'Ctrl + Shift + E', description: 'Export video' },
];

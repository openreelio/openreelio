/**
 * useCommandPalette Hook
 *
 * Collects all available actions from the application (keyboard shortcuts,
 * editor tools, store actions) and provides fuzzy search filtering.
 * Returns a filtered list of PaletteActions based on the current search query.
 */

import { useMemo, useCallback } from 'react';
import { createLogger } from '@/services/logger';
import { PLAYBACK } from '@/constants/preview';
import { useProjectStore } from '@/stores/projectStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';
import { useEditorToolStore, TOOL_CONFIGS } from '@/stores/editorToolStore';
import { useUIStore } from '@/stores/uiStore';
import {
  useCommandPaletteStore,
  type PaletteAction,
  type ActionCategory,
} from '@/stores/commandPaletteStore';

// =============================================================================
// Types
// =============================================================================

/** Callbacks provided by the parent component for context-dependent actions */
export interface CommandPaletteCallbacks {
  onSplitAtPlayhead?: () => void;
  onDeleteClips?: () => void;
  onExport?: () => void;
  onExportEdl?: () => void;
  onExportFcpxml?: () => void;
  onExportFrame?: () => void;
  onExportAudio?: () => void;
  onMatchFrame?: () => void;
  onReverseMatchFrame?: () => void;
  onCopyEffects?: () => void;
  onPasteEffects?: () => void;
  onToggleClipEnabled?: () => void;
  onToggleColorComparison?: () => void;
  onToggleMixer?: () => void;
  onAddText?: () => void;
  onAutoDuck?: () => void;
}

export interface UseCommandPaletteReturn {
  /** Whether the palette is open */
  isOpen: boolean;
  /** Current search query */
  searchQuery: string;
  /** Index of the selected item */
  selectedIndex: number;
  /** Filtered actions based on search query */
  filteredActions: PaletteAction[];
  /** Recent actions (when no search query) */
  recentActions: PaletteAction[];
  /** Open the palette */
  open: () => void;
  /** Close the palette */
  close: () => void;
  /** Update search query */
  setSearchQuery: (query: string) => void;
  /** Set selected index */
  setSelectedIndex: (index: number) => void;
  /** Execute an action by ID */
  executeAction: (actionId: string) => void;
}

// =============================================================================
// Helpers
// =============================================================================

const logger = createLogger('useCommandPalette');

/** Case-insensitive substring match for filtering */
function matchesQuery(label: string, category: string, query: string): boolean {
  const lowerQuery = query.toLowerCase();
  const lowerLabel = label.toLowerCase();
  const lowerCategory = category.toLowerCase();

  // Match against label or category
  if (lowerLabel.includes(lowerQuery) || lowerCategory.includes(lowerQuery)) {
    return true;
  }

  // Fuzzy: match query words individually
  const queryWords = lowerQuery.split(/\s+/).filter(Boolean);
  const target = `${lowerCategory} ${lowerLabel}`;
  return queryWords.every((word) => target.includes(word));
}

/** Create a static action definition */
function action(
  id: string,
  label: string,
  category: ActionCategory,
  execute: () => void,
  shortcut?: string,
): PaletteAction {
  return { id, label, category, execute, shortcut, enabled: true };
}

// =============================================================================
// Hook
// =============================================================================

export function useCommandPalette(callbacks: CommandPaletteCallbacks = {}): UseCommandPaletteReturn {
  const {
    isOpen,
    searchQuery,
    selectedIndex,
    recentActionIds,
    open,
    close,
    setSearchQuery,
    setSelectedIndex,
    recordRecentAction,
  } = useCommandPaletteStore();

  // Store actions
  const { undo, redo, saveProject, isLoaded } = useProjectStore();
  const { togglePlayback, seek, stepForward, stepBackward } = usePlaybackStore();
  const duration = usePlaybackStore((s) => s.duration);
  const { zoomIn, zoomOut, clearClipSelection } = useTimelineStore();
  const { setActiveTool } = useEditorToolStore();
  const { openSettings } = useUIStore();

  // Build the complete action registry
  const allActions: PaletteAction[] = useMemo(() => {
    const actions: PaletteAction[] = [];

    // --- Transport Actions ---
    actions.push(
      action('transport.play-pause', 'Play / Pause', 'Transport', () => togglePlayback(), 'Space'),
      action('transport.go-to-start', 'Go to Timeline Start', 'Transport', () => seek(0), 'Home'),
      action('transport.go-to-end', 'Go to Timeline End', 'Transport', () => seek(duration), 'End'),
      action('transport.previous-frame', 'Previous Frame', 'Transport', () => stepBackward(PLAYBACK.TARGET_FPS), 'Left'),
      action('transport.next-frame', 'Next Frame', 'Transport', () => stepForward(PLAYBACK.TARGET_FPS), 'Right'),
    );

    // --- Edit Actions ---
    actions.push(
      action('edit.undo', 'Undo', 'Edit', () => { if (isLoaded) void undo(); }, 'Ctrl+Z'),
      action('edit.redo', 'Redo', 'Edit', () => { if (isLoaded) void redo(); }, 'Ctrl+Shift+Z'),
      action('edit.save', 'Save Project', 'Edit', () => { if (isLoaded) void saveProject(); }, 'Ctrl+S'),
      action('edit.deselect', 'Deselect All', 'Edit', () => clearClipSelection(), 'Esc'),
    );

    if (callbacks.onSplitAtPlayhead) {
      const cb = callbacks.onSplitAtPlayhead;
      actions.push(action('edit.split', 'Split Clip at Playhead', 'Edit', () => cb(), 'S'));
    }

    if (callbacks.onDeleteClips) {
      const cb = callbacks.onDeleteClips;
      actions.push(action('edit.delete', 'Delete Selected Clips', 'Edit', () => cb(), 'Delete'));
    }

    if (callbacks.onCopyEffects) {
      const cb = callbacks.onCopyEffects;
      actions.push(action('edit.copy-effects', 'Copy Effects', 'Edit', () => cb(), 'Ctrl+Alt+C'));
    }

    if (callbacks.onPasteEffects) {
      const cb = callbacks.onPasteEffects;
      actions.push(action('edit.paste-effects', 'Paste Effects', 'Edit', () => cb(), 'Ctrl+Alt+V'));
    }

    if (callbacks.onToggleClipEnabled) {
      const cb = callbacks.onToggleClipEnabled;
      actions.push(action('edit.toggle-enabled', 'Toggle Clip Enabled', 'Edit', () => cb(), 'Shift+E'));
    }

    // --- View Actions ---
    actions.push(
      action('view.zoom-in', 'Zoom In Timeline', 'View', () => zoomIn(), 'Ctrl+='),
      action('view.zoom-out', 'Zoom Out Timeline', 'View', () => zoomOut(), 'Ctrl+-'),
    );

    if (callbacks.onExport) {
      const cb = callbacks.onExport;
      actions.push(action('view.export', 'Export Video', 'Export', () => cb(), 'Ctrl+Shift+E'));
    }

    if (callbacks.onExportEdl) {
      const cb = callbacks.onExportEdl;
      actions.push(action('view.export-edl', 'Export as EDL...', 'Export', () => cb()));
    }

    if (callbacks.onExportFcpxml) {
      const cb = callbacks.onExportFcpxml;
      actions.push(action('view.export-fcpxml', 'Export as FCPXML...', 'Export', () => cb()));
    }

    if (callbacks.onExportFrame) {
      const cb = callbacks.onExportFrame;
      actions.push(action('view.export-frame', 'Export Current Frame...', 'Export', () => cb()));
    }

    if (callbacks.onExportAudio) {
      const cb = callbacks.onExportAudio;
      actions.push(action('view.export-audio', 'Export Audio Only...', 'Export', () => cb()));
    }

    if (callbacks.onToggleMixer) {
      const cb = callbacks.onToggleMixer;
      actions.push(action('view.toggle-mixer', 'Toggle Audio Mixer', 'Audio', () => cb()));
    }

    if (callbacks.onAddText) {
      const cb = callbacks.onAddText;
      actions.push(action('view.add-text', 'Add Text Clip', 'Timeline', () => cb()));
    }

    // --- Source Monitor Actions ---
    if (callbacks.onMatchFrame) {
      const cb = callbacks.onMatchFrame;
      actions.push(action('source.match-frame', 'Match Frame', 'Source', () => cb(), 'F'));
    }

    if (callbacks.onReverseMatchFrame) {
      const cb = callbacks.onReverseMatchFrame;
      actions.push(action('source.reverse-match-frame', 'Reverse Match Frame', 'Source', () => cb(), 'Shift+F'));
    }

    // --- Tool Actions ---
    for (const [toolId, config] of Object.entries(TOOL_CONFIGS)) {
      actions.push(
        action(
          `tool.${toolId}`,
          `${config.label}`,
          'Tools',
          () => setActiveTool(toolId as Parameters<typeof setActiveTool>[0]),
          config.shortcut,
        ),
      );
    }

    // --- Effects Actions ---
    if (callbacks.onToggleColorComparison) {
      const cb = callbacks.onToggleColorComparison;
      actions.push(action('effects.color-comparison', 'Toggle Before/After Color Comparison', 'Effects', () => cb(), 'Shift+D'));
    }

    // --- Audio Actions ---
    if (callbacks.onAutoDuck) {
      const cb = callbacks.onAutoDuck;
      actions.push(action('audio.auto-duck', 'Auto-Duck Audio', 'Audio', () => cb()));
    }

    // --- Settings Actions ---
    actions.push(
      action('settings.open', 'Open Settings', 'Settings', () => openSettings(), 'Ctrl+,'),
      action('settings.general', 'Settings: General', 'Settings', () => openSettings('general')),
      action('settings.playback', 'Settings: Playback', 'Settings', () => openSettings('playback')),
      action('settings.appearance', 'Settings: Appearance', 'Settings', () => openSettings('appearance')),
      action('settings.shortcuts', 'Settings: Keyboard Shortcuts', 'Settings', () => openSettings('shortcuts')),
      action('settings.ai', 'Settings: AI', 'Settings', () => openSettings('ai')),
      action('settings.developer', 'Settings: Developer', 'Settings', () => openSettings('developer')),
    );

    return actions;
  }, [
    togglePlayback, seek, duration, stepForward, stepBackward,
    isLoaded, undo, redo, saveProject,
    clearClipSelection, zoomIn, zoomOut, setActiveTool, openSettings,
    callbacks.onSplitAtPlayhead, callbacks.onDeleteClips,
    callbacks.onExport, callbacks.onExportEdl, callbacks.onExportFcpxml,
    callbacks.onExportFrame, callbacks.onExportAudio,
    callbacks.onMatchFrame, callbacks.onReverseMatchFrame,
    callbacks.onCopyEffects, callbacks.onPasteEffects,
    callbacks.onToggleClipEnabled, callbacks.onToggleColorComparison,
    callbacks.onToggleMixer, callbacks.onAddText, callbacks.onAutoDuck,
  ]);

  // Filter actions based on search query
  const filteredActions = useMemo(() => {
    if (!searchQuery.trim()) {
      return allActions;
    }
    return allActions.filter((a) => matchesQuery(a.label, a.category, searchQuery));
  }, [allActions, searchQuery]);

  // Recent actions (resolved from IDs, only show when no query)
  const recentActions = useMemo(() => {
    if (searchQuery.trim()) return [];
    const actionMap = new Map(allActions.map((a) => [a.id, a]));
    return recentActionIds
      .map((id) => actionMap.get(id))
      .filter((a): a is PaletteAction => a !== undefined);
  }, [allActions, recentActionIds, searchQuery]);

  // Execute action and close palette
  const executeAction = useCallback(
    (actionId: string) => {
      const found = allActions.find((a) => a.id === actionId);
      if (!found) {
        logger.warn('Command palette action not found', { actionId });
        return;
      }
      recordRecentAction(actionId);
      close();
      // Execute after close so the action doesn't interact with the palette
      requestAnimationFrame(() => {
        try {
          found.execute();
        } catch (error) {
          logger.error('Command palette action failed', { actionId, error });
        }
      });
    },
    [allActions, recordRecentAction, close],
  );

  return {
    isOpen,
    searchQuery,
    selectedIndex,
    filteredActions,
    recentActions,
    open,
    close,
    setSearchQuery,
    setSelectedIndex,
    executeAction,
  };
}

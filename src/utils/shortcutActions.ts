/**
 * Shortcut Actions Registry
 *
 * Defines all available keyboard shortcut actions and their default bindings.
 * Actions are organized by category for UI display.
 */

import { compareSignatures } from './shortcutUtils';

// =============================================================================
// Types
// =============================================================================

/**
 * Categories for organizing shortcuts in the UI.
 */
export type ShortcutCategory =
  | 'playback'
  | 'timeline'
  | 'project'
  | 'navigation'
  | 'view'
  | 'tools';

/**
 * Definition of a shortcut action.
 */
export interface ShortcutAction {
  /** Unique identifier (e.g., "playback.playPause") */
  id: string;
  /** Display label (e.g., "Play/Pause") */
  label: string;
  /** Category for grouping */
  category: ShortcutCategory;
  /** Optional description */
  description?: string;
}

/**
 * Shortcut entry for display in category groups.
 */
export interface ShortcutEntry {
  actionId: string;
  label: string;
  shortcut: string | undefined;
  description?: string;
}

/**
 * Custom shortcut overrides (action ID -> key signature).
 */
export type CustomShortcuts = Record<string, string>;

// =============================================================================
// Action Registry
// =============================================================================

/**
 * All available shortcut actions.
 */
export const SHORTCUT_ACTIONS: Record<string, ShortcutAction> = {
  // Playback
  'playback.playPause': {
    id: 'playback.playPause',
    label: 'Play/Pause',
    category: 'playback',
    description: 'Toggle playback',
  },
  'playback.stop': {
    id: 'playback.stop',
    label: 'Stop',
    category: 'playback',
    description: 'Stop playback and return to start',
  },
  'playback.frameForward': {
    id: 'playback.frameForward',
    label: 'Frame Forward',
    category: 'playback',
    description: 'Move one frame forward',
  },
  'playback.frameBackward': {
    id: 'playback.frameBackward',
    label: 'Frame Backward',
    category: 'playback',
    description: 'Move one frame backward',
  },
  'playback.shuttleForward': {
    id: 'playback.shuttleForward',
    label: 'Shuttle Forward',
    category: 'playback',
    description: 'Increase playback speed forward (JKL)',
  },
  'playback.shuttleBackward': {
    id: 'playback.shuttleBackward',
    label: 'Shuttle Backward',
    category: 'playback',
    description: 'Increase playback speed backward (JKL)',
  },
  'playback.shuttleStop': {
    id: 'playback.shuttleStop',
    label: 'Shuttle Stop',
    category: 'playback',
    description: 'Stop shuttle playback (JKL)',
  },
  'playback.goToStart': {
    id: 'playback.goToStart',
    label: 'Go to Start',
    category: 'playback',
    description: 'Jump to beginning of timeline',
  },
  'playback.goToEnd': {
    id: 'playback.goToEnd',
    label: 'Go to End',
    category: 'playback',
    description: 'Jump to end of timeline',
  },

  // Timeline
  'timeline.split': {
    id: 'timeline.split',
    label: 'Split Clip',
    category: 'timeline',
    description: 'Split selected clip at playhead',
  },
  'timeline.delete': {
    id: 'timeline.delete',
    label: 'Delete',
    category: 'timeline',
    description: 'Delete selected clips',
  },
  'timeline.rippleDelete': {
    id: 'timeline.rippleDelete',
    label: 'Ripple Delete',
    category: 'timeline',
    description: 'Delete and close gap',
  },
  'timeline.selectAll': {
    id: 'timeline.selectAll',
    label: 'Select All',
    category: 'timeline',
    description: 'Select all clips on timeline',
  },
  'timeline.deselectAll': {
    id: 'timeline.deselectAll',
    label: 'Deselect All',
    category: 'timeline',
    description: 'Clear selection',
  },
  'timeline.cut': {
    id: 'timeline.cut',
    label: 'Cut',
    category: 'timeline',
    description: 'Cut selected clips',
  },
  'timeline.copy': {
    id: 'timeline.copy',
    label: 'Copy',
    category: 'timeline',
    description: 'Copy selected clips',
  },
  'timeline.paste': {
    id: 'timeline.paste',
    label: 'Paste',
    category: 'timeline',
    description: 'Paste clips at playhead',
  },
  'timeline.duplicate': {
    id: 'timeline.duplicate',
    label: 'Duplicate',
    category: 'timeline',
    description: 'Duplicate selected clips',
  },

  // Project
  'project.save': {
    id: 'project.save',
    label: 'Save Project',
    category: 'project',
    description: 'Save current project',
  },
  'project.undo': {
    id: 'project.undo',
    label: 'Undo',
    category: 'project',
    description: 'Undo last action',
  },
  'project.redo': {
    id: 'project.redo',
    label: 'Redo',
    category: 'project',
    description: 'Redo last undone action',
  },
  'project.import': {
    id: 'project.import',
    label: 'Import Media',
    category: 'project',
    description: 'Import media files',
  },
  'project.export': {
    id: 'project.export',
    label: 'Export',
    category: 'project',
    description: 'Export project',
  },

  // Navigation
  'navigate.zoomIn': {
    id: 'navigate.zoomIn',
    label: 'Zoom In',
    category: 'navigation',
    description: 'Zoom in on timeline',
  },
  'navigate.zoomOut': {
    id: 'navigate.zoomOut',
    label: 'Zoom Out',
    category: 'navigation',
    description: 'Zoom out on timeline',
  },
  'navigate.fitToWindow': {
    id: 'navigate.fitToWindow',
    label: 'Fit to Window',
    category: 'navigation',
    description: 'Fit entire timeline in view',
  },
  'navigate.goToPreviousClip': {
    id: 'navigate.goToPreviousClip',
    label: 'Previous Clip',
    category: 'navigation',
    description: 'Jump to previous clip edge',
  },
  'navigate.goToNextClip': {
    id: 'navigate.goToNextClip',
    label: 'Next Clip',
    category: 'navigation',
    description: 'Jump to next clip edge',
  },

  // View
  'view.toggleFullscreen': {
    id: 'view.toggleFullscreen',
    label: 'Toggle Fullscreen',
    category: 'view',
    description: 'Toggle fullscreen mode',
  },
  'view.toggleTimeline': {
    id: 'view.toggleTimeline',
    label: 'Toggle Timeline',
    category: 'view',
    description: 'Show/hide timeline panel',
  },
  'view.toggleInspector': {
    id: 'view.toggleInspector',
    label: 'Toggle Inspector',
    category: 'view',
    description: 'Show/hide inspector panel',
  },
  'view.toggleExplorer': {
    id: 'view.toggleExplorer',
    label: 'Toggle Explorer',
    category: 'view',
    description: 'Show/hide project explorer',
  },

  // Tools
  'tools.selectTool': {
    id: 'tools.selectTool',
    label: 'Selection Tool',
    category: 'tools',
    description: 'Switch to selection tool',
  },
  'tools.razorTool': {
    id: 'tools.razorTool',
    label: 'Razor Tool',
    category: 'tools',
    description: 'Switch to razor/blade tool',
  },
  'tools.handTool': {
    id: 'tools.handTool',
    label: 'Hand Tool',
    category: 'tools',
    description: 'Switch to hand/pan tool',
  },
};

// =============================================================================
// Default Shortcuts
// =============================================================================

/**
 * Default keyboard shortcuts for actions.
 */
export const DEFAULT_SHORTCUTS: CustomShortcuts = {
  // Playback
  'playback.playPause': 'Space',
  'playback.stop': 'Escape',
  'playback.frameForward': 'ArrowRight',
  'playback.frameBackward': 'ArrowLeft',
  'playback.shuttleForward': 'L',
  'playback.shuttleBackward': 'J',
  'playback.shuttleStop': 'K',
  'playback.goToStart': 'Home',
  'playback.goToEnd': 'End',

  // Timeline
  'timeline.split': 'S',
  'timeline.delete': 'Delete',
  'timeline.rippleDelete': 'Shift+Delete',
  'timeline.selectAll': 'Ctrl+A',
  'timeline.deselectAll': 'Ctrl+D',
  'timeline.cut': 'Ctrl+X',
  'timeline.copy': 'Ctrl+C',
  'timeline.paste': 'Ctrl+V',
  'timeline.duplicate': 'Ctrl+Shift+D',

  // Project
  'project.save': 'Ctrl+S',
  'project.undo': 'Ctrl+Z',
  'project.redo': 'Ctrl+Shift+Z',
  'project.import': 'Ctrl+I',
  'project.export': 'Ctrl+E',

  // Navigation
  'navigate.zoomIn': 'Ctrl+=',
  'navigate.zoomOut': 'Ctrl+-',
  'navigate.fitToWindow': 'Shift+Z',
  'navigate.goToPreviousClip': 'ArrowUp',
  'navigate.goToNextClip': 'ArrowDown',

  // View
  'view.toggleFullscreen': 'F11',
  'view.toggleTimeline': 'Ctrl+1',
  'view.toggleInspector': 'Ctrl+2',
  'view.toggleExplorer': 'Ctrl+3',

  // Tools
  'tools.selectTool': 'V',
  'tools.razorTool': 'C',
  'tools.handTool': 'H',
};

// =============================================================================
// Lookup Functions
// =============================================================================

/**
 * Gets a shortcut action by ID.
 *
 * @param actionId - The action ID
 * @returns The action definition or undefined
 */
export function getShortcutAction(actionId: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS[actionId];
}

/**
 * Finds the action bound to a given shortcut.
 *
 * @param shortcut - Key signature to look up
 * @param customShortcuts - Optional custom shortcut overrides
 * @returns Action ID or undefined if no action is bound
 */
export function getActionByShortcut(
  shortcut: string,
  customShortcuts?: CustomShortcuts
): string | undefined {
  // If we have custom shortcuts, only use those bindings
  // (custom shortcuts completely replace the action's binding)
  if (customShortcuts) {
    for (const [actionId, keySignature] of Object.entries(customShortcuts)) {
      if (compareSignatures(shortcut, keySignature)) {
        return actionId;
      }
    }
    // Check defaults for actions not in custom
    for (const [actionId, keySignature] of Object.entries(DEFAULT_SHORTCUTS)) {
      if (!(actionId in customShortcuts) && compareSignatures(shortcut, keySignature)) {
        return actionId;
      }
    }
    return undefined;
  }

  // No custom shortcuts, just check defaults
  for (const [actionId, keySignature] of Object.entries(DEFAULT_SHORTCUTS)) {
    if (compareSignatures(shortcut, keySignature)) {
      return actionId;
    }
  }

  return undefined;
}

/**
 * Gets the shortcut bound to an action.
 *
 * @param actionId - The action ID
 * @param customShortcuts - Optional custom shortcut overrides
 * @returns Key signature or undefined if not bound
 */
export function getShortcutForAction(
  actionId: string,
  customShortcuts?: CustomShortcuts
): string | undefined {
  // Check custom first
  if (customShortcuts && actionId in customShortcuts) {
    return customShortcuts[actionId];
  }
  // Fall back to default
  return DEFAULT_SHORTCUTS[actionId];
}

/**
 * Gets all shortcuts merged with custom overrides.
 *
 * @param customShortcuts - Optional custom shortcut overrides
 * @returns Complete shortcut map
 */
export function getAllShortcuts(customShortcuts?: CustomShortcuts): CustomShortcuts {
  return customShortcuts
    ? { ...DEFAULT_SHORTCUTS, ...customShortcuts }
    : { ...DEFAULT_SHORTCUTS };
}

/**
 * Gets shortcuts organized by category for UI display.
 *
 * @param customShortcuts - Optional custom shortcut overrides
 * @returns Shortcuts grouped by category
 */
export function getShortcutsByCategory(
  customShortcuts?: CustomShortcuts
): Record<ShortcutCategory, ShortcutEntry[]> {
  const result: Record<ShortcutCategory, ShortcutEntry[]> = {
    playback: [],
    timeline: [],
    project: [],
    navigation: [],
    view: [],
    tools: [],
  };

  for (const action of Object.values(SHORTCUT_ACTIONS)) {
    const entry: ShortcutEntry = {
      actionId: action.id,
      label: action.label,
      shortcut: getShortcutForAction(action.id, customShortcuts),
      description: action.description,
    };
    result[action.category].push(entry);
  }

  return result;
}

/**
 * Shortcut Store
 *
 * Manages customizable keyboard shortcuts with conflict detection,
 * persistence, and preset support.
 *
 * @module stores/shortcutStore
 */

import { create } from 'zustand';
import { persist, devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { ModifierKey, ShortcutCategory } from '@/constants/editing';

// =============================================================================
// Types
// =============================================================================

/**
 * A single keyboard shortcut binding
 */
export interface ShortcutBinding {
  /** Unique identifier for the shortcut */
  id: string;
  /** Display label for the shortcut */
  label: string;
  /** Description of what the shortcut does */
  description: string;
  /** The key code (e.g., 'KeyV', 'Space', 'ArrowLeft') */
  key: string;
  /** Required modifier keys */
  modifiers: ModifierKey[];
  /** Action identifier to trigger */
  action: string;
  /** Category for grouping in UI */
  category: ShortcutCategory;
  /** Whether this binding has been customized from default */
  customized: boolean;
  /** Whether this shortcut is enabled */
  enabled: boolean;
}

/**
 * A preset collection of shortcuts
 */
export interface ShortcutPreset {
  id: string;
  name: string;
  description: string;
  bindings: Omit<ShortcutBinding, 'customized' | 'enabled'>[];
}

/**
 * Conflict information when two shortcuts collide
 */
export interface ShortcutConflict {
  existingBinding: ShortcutBinding;
  newBinding: Partial<ShortcutBinding>;
  conflictKey: string;
}

/**
 * Shortcut store state
 */
interface ShortcutState {
  /** All current shortcut bindings */
  bindings: ShortcutBinding[];
  /** Currently active preset name (null if custom) */
  activePreset: string | null;
  /** Whether the shortcuts panel is open */
  isPanelOpen: boolean;
}

/**
 * Shortcut store actions
 */
interface ShortcutActions {
  /** Update a specific shortcut binding. Set allowConflict=true to apply even when conflict exists */
  updateBinding: (id: string, updates: Partial<Pick<ShortcutBinding, 'key' | 'modifiers' | 'enabled'>>, allowConflict?: boolean) => ShortcutConflict | null;
  /** Reset a single binding to default */
  resetBinding: (id: string) => void;
  /** Reset all bindings to defaults */
  resetAllBindings: () => void;
  /** Apply a preset */
  applyPreset: (presetId: string) => void;
  /** Check for conflicts with a proposed binding */
  checkConflict: (id: string, key: string, modifiers: ModifierKey[]) => ShortcutConflict | null;
  /** Get binding by action name */
  getBindingByAction: (action: string) => ShortcutBinding | undefined;
  /** Get binding by id */
  getBindingById: (id: string) => ShortcutBinding | undefined;
  /** Get all bindings in a category */
  getBindingsByCategory: (category: ShortcutCategory) => ShortcutBinding[];
  /** Toggle shortcuts panel */
  togglePanel: () => void;
  /** Set panel open state */
  setPanelOpen: (open: boolean) => void;
  /** Export bindings as JSON */
  exportBindings: () => string;
  /** Import bindings from JSON */
  importBindings: (json: string) => boolean;
}

export type ShortcutStore = ShortcutState & ShortcutActions;

// =============================================================================
// Default Shortcuts
// =============================================================================

export const DEFAULT_SHORTCUTS: Omit<ShortcutBinding, 'customized' | 'enabled'>[] = [
  // Playback
  { id: 'play-pause', label: 'Play/Pause', description: 'Toggle playback', key: 'Space', modifiers: [], action: 'playback.toggle', category: 'playback' },
  { id: 'stop', label: 'Stop', description: 'Stop and return to start', key: 'KeyS', modifiers: ['ctrl'], action: 'playback.stop', category: 'playback' },
  { id: 'shuttle-back', label: 'Shuttle Back', description: 'Reverse playback (J/K/L)', key: 'KeyJ', modifiers: [], action: 'playback.shuttleBack', category: 'playback' },
  { id: 'shuttle-stop', label: 'Shuttle Stop', description: 'Stop shuttle (J/K/L)', key: 'KeyK', modifiers: [], action: 'playback.shuttleStop', category: 'playback' },
  { id: 'shuttle-forward', label: 'Shuttle Forward', description: 'Forward playback (J/K/L)', key: 'KeyL', modifiers: [], action: 'playback.shuttleForward', category: 'playback' },
  { id: 'frame-back', label: 'Frame Back', description: 'Step one frame back', key: 'ArrowLeft', modifiers: [], action: 'playback.frameBack', category: 'playback' },
  { id: 'frame-forward', label: 'Frame Forward', description: 'Step one frame forward', key: 'ArrowRight', modifiers: [], action: 'playback.frameForward', category: 'playback' },

  // Navigation
  { id: 'go-to-start', label: 'Go to Start', description: 'Jump to timeline start', key: 'Home', modifiers: [], action: 'navigation.goToStart', category: 'navigation' },
  { id: 'go-to-end', label: 'Go to End', description: 'Jump to timeline end', key: 'End', modifiers: [], action: 'navigation.goToEnd', category: 'navigation' },
  { id: 'seek-back', label: 'Seek Back 1s', description: 'Seek backward 1 second', key: 'ArrowLeft', modifiers: ['shift'], action: 'navigation.seekBack', category: 'navigation' },
  { id: 'seek-forward', label: 'Seek Forward 1s', description: 'Seek forward 1 second', key: 'ArrowRight', modifiers: ['shift'], action: 'navigation.seekForward', category: 'navigation' },
  { id: 'seek-back-large', label: 'Seek Back 5s', description: 'Seek backward 5 seconds', key: 'ArrowLeft', modifiers: ['ctrl', 'shift'], action: 'navigation.seekBackLarge', category: 'navigation' },
  { id: 'seek-forward-large', label: 'Seek Forward 5s', description: 'Seek forward 5 seconds', key: 'ArrowRight', modifiers: ['ctrl', 'shift'], action: 'navigation.seekForwardLarge', category: 'navigation' },
  { id: 'prev-clip', label: 'Previous Clip', description: 'Jump to previous clip edge', key: 'ArrowUp', modifiers: [], action: 'navigation.prevClip', category: 'navigation' },
  { id: 'next-clip', label: 'Next Clip', description: 'Jump to next clip edge', key: 'ArrowDown', modifiers: [], action: 'navigation.nextClip', category: 'navigation' },

  // Tools
  { id: 'tool-select', label: 'Selection Tool', description: 'Switch to selection tool', key: 'KeyV', modifiers: [], action: 'tool.select', category: 'tools' },
  { id: 'tool-razor', label: 'Razor Tool', description: 'Switch to razor/cut tool', key: 'KeyC', modifiers: [], action: 'tool.razor', category: 'tools' },
  { id: 'tool-ripple', label: 'Ripple Tool', description: 'Switch to ripple edit tool', key: 'KeyB', modifiers: [], action: 'tool.ripple', category: 'tools' },
  { id: 'tool-slip', label: 'Slip Tool', description: 'Switch to slip edit tool', key: 'KeyY', modifiers: [], action: 'tool.slip', category: 'tools' },
  { id: 'tool-slide', label: 'Slide Tool', description: 'Switch to slide edit tool', key: 'KeyU', modifiers: [], action: 'tool.slide', category: 'tools' },
  { id: 'tool-roll', label: 'Roll Tool', description: 'Switch to roll edit tool', key: 'KeyN', modifiers: [], action: 'tool.roll', category: 'tools' },
  { id: 'tool-hand', label: 'Hand Tool', description: 'Switch to hand/pan tool', key: 'KeyH', modifiers: [], action: 'tool.hand', category: 'tools' },

  // Editing
  { id: 'split', label: 'Split at Playhead', description: 'Split clip at playhead position', key: 'KeyS', modifiers: [], action: 'edit.split', category: 'editing' },
  { id: 'split-keep-left', label: 'Split Keep Left', description: 'Split and keep left portion', key: 'KeyQ', modifiers: [], action: 'edit.splitKeepLeft', category: 'editing' },
  { id: 'split-keep-right', label: 'Split Keep Right', description: 'Split and keep right portion', key: 'KeyW', modifiers: [], action: 'edit.splitKeepRight', category: 'editing' },
  { id: 'delete', label: 'Delete', description: 'Delete selected clips', key: 'Delete', modifiers: [], action: 'edit.delete', category: 'editing' },
  { id: 'ripple-delete', label: 'Ripple Delete', description: 'Delete and close gap', key: 'Delete', modifiers: ['shift'], action: 'edit.rippleDelete', category: 'editing' },
  { id: 'duplicate', label: 'Duplicate', description: 'Duplicate selected clips', key: 'KeyD', modifiers: ['ctrl'], action: 'edit.duplicate', category: 'editing' },
  { id: 'copy', label: 'Copy', description: 'Copy selected clips', key: 'KeyC', modifiers: ['ctrl'], action: 'edit.copy', category: 'editing' },
  { id: 'cut', label: 'Cut', description: 'Cut selected clips', key: 'KeyX', modifiers: ['ctrl'], action: 'edit.cut', category: 'editing' },
  { id: 'paste', label: 'Paste', description: 'Paste clips at playhead', key: 'KeyV', modifiers: ['ctrl'], action: 'edit.paste', category: 'editing' },
  { id: 'undo', label: 'Undo', description: 'Undo last action', key: 'KeyZ', modifiers: ['ctrl'], action: 'edit.undo', category: 'editing' },
  { id: 'redo', label: 'Redo', description: 'Redo last undone action', key: 'KeyY', modifiers: ['ctrl'], action: 'edit.redo', category: 'editing' },
  { id: 'redo-alt', label: 'Redo (Alt)', description: 'Redo last undone action', key: 'KeyZ', modifiers: ['ctrl', 'shift'], action: 'edit.redo', category: 'editing' },

  // Selection
  { id: 'select-all', label: 'Select All', description: 'Select all clips', key: 'KeyA', modifiers: ['ctrl'], action: 'selection.selectAll', category: 'selection' },
  { id: 'deselect-all', label: 'Deselect All', description: 'Clear selection', key: 'KeyD', modifiers: ['ctrl', 'shift'], action: 'selection.deselectAll', category: 'selection' },
  { id: 'select-clip-at-playhead', label: 'Select at Playhead', description: 'Select clip at playhead', key: 'KeyD', modifiers: [], action: 'selection.selectAtPlayhead', category: 'selection' },

  // View
  { id: 'zoom-in', label: 'Zoom In', description: 'Zoom into timeline', key: 'Equal', modifiers: ['ctrl'], action: 'view.zoomIn', category: 'view' },
  { id: 'zoom-out', label: 'Zoom Out', description: 'Zoom out of timeline', key: 'Minus', modifiers: ['ctrl'], action: 'view.zoomOut', category: 'view' },
  { id: 'zoom-fit', label: 'Zoom to Fit', description: 'Fit timeline in view', key: 'Digit0', modifiers: ['ctrl'], action: 'view.zoomFit', category: 'view' },
  { id: 'toggle-snap', label: 'Toggle Snapping', description: 'Toggle snap to grid/clips', key: 'KeyN', modifiers: ['ctrl'], action: 'view.toggleSnap', category: 'view' },
  { id: 'toggle-ripple', label: 'Toggle Ripple Mode', description: 'Toggle ripple editing mode', key: 'KeyR', modifiers: ['ctrl'], action: 'view.toggleRipple', category: 'view' },
  { id: 'toggle-auto-scroll', label: 'Toggle Auto-Scroll', description: 'Toggle playhead auto-follow', key: 'KeyF', modifiers: ['ctrl'], action: 'view.toggleAutoScroll', category: 'view' },

  // File
  { id: 'save', label: 'Save', description: 'Save project', key: 'KeyS', modifiers: ['ctrl'], action: 'file.save', category: 'file' },
  { id: 'save-as', label: 'Save As', description: 'Save project as new file', key: 'KeyS', modifiers: ['ctrl', 'shift'], action: 'file.saveAs', category: 'file' },
  { id: 'export', label: 'Export', description: 'Export project', key: 'KeyE', modifiers: ['ctrl'], action: 'file.export', category: 'file' },
  { id: 'shortcuts-help', label: 'Keyboard Shortcuts', description: 'Show keyboard shortcuts', key: 'Slash', modifiers: ['ctrl'], action: 'file.showShortcuts', category: 'file' },

  // Multicam (active only when in multicam editing mode)
  { id: 'multicam-angle-1', label: 'Multicam Angle 1', description: 'Switch to angle 1', key: 'Digit1', modifiers: [], action: 'multicam.switchAngle1', category: 'multicam' },
  { id: 'multicam-angle-2', label: 'Multicam Angle 2', description: 'Switch to angle 2', key: 'Digit2', modifiers: [], action: 'multicam.switchAngle2', category: 'multicam' },
  { id: 'multicam-angle-3', label: 'Multicam Angle 3', description: 'Switch to angle 3', key: 'Digit3', modifiers: [], action: 'multicam.switchAngle3', category: 'multicam' },
  { id: 'multicam-angle-4', label: 'Multicam Angle 4', description: 'Switch to angle 4', key: 'Digit4', modifiers: [], action: 'multicam.switchAngle4', category: 'multicam' },
  { id: 'multicam-angle-5', label: 'Multicam Angle 5', description: 'Switch to angle 5', key: 'Digit5', modifiers: [], action: 'multicam.switchAngle5', category: 'multicam' },
  { id: 'multicam-angle-6', label: 'Multicam Angle 6', description: 'Switch to angle 6', key: 'Digit6', modifiers: [], action: 'multicam.switchAngle6', category: 'multicam' },
  { id: 'multicam-angle-7', label: 'Multicam Angle 7', description: 'Switch to angle 7', key: 'Digit7', modifiers: [], action: 'multicam.switchAngle7', category: 'multicam' },
  { id: 'multicam-angle-8', label: 'Multicam Angle 8', description: 'Switch to angle 8', key: 'Digit8', modifiers: [], action: 'multicam.switchAngle8', category: 'multicam' },
  { id: 'multicam-angle-9', label: 'Multicam Angle 9', description: 'Switch to angle 9', key: 'Digit9', modifiers: [], action: 'multicam.switchAngle9', category: 'multicam' },
];

// =============================================================================
// Presets
// =============================================================================

export const SHORTCUT_PRESETS: ShortcutPreset[] = [
  {
    id: 'default',
    name: 'OpenReelio Default',
    description: 'Default keyboard shortcuts',
    bindings: DEFAULT_SHORTCUTS,
  },
  {
    id: 'premiere',
    name: 'Premiere Pro Style',
    description: 'Shortcuts similar to Adobe Premiere Pro',
    bindings: [
      ...DEFAULT_SHORTCUTS.filter(s => !['tool-razor', 'split'].includes(s.id)),
      { id: 'tool-razor', label: 'Razor Tool', description: 'Switch to razor tool', key: 'KeyC', modifiers: [], action: 'tool.razor', category: 'tools' },
      { id: 'split', label: 'Add Edit', description: 'Add edit at playhead', key: 'KeyK', modifiers: ['ctrl'], action: 'edit.split', category: 'editing' },
    ],
  },
  {
    id: 'davinci',
    name: 'DaVinci Resolve Style',
    description: 'Shortcuts similar to DaVinci Resolve',
    bindings: [
      ...DEFAULT_SHORTCUTS.filter(s => !['tool-razor', 'split'].includes(s.id)),
      { id: 'tool-razor', label: 'Blade Tool', description: 'Switch to blade tool', key: 'KeyB', modifiers: [], action: 'tool.razor', category: 'tools' },
      { id: 'split', label: 'Split Clip', description: 'Split clip at playhead', key: 'Backslash', modifiers: ['ctrl'], action: 'edit.split', category: 'editing' },
    ],
  },
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a unique key string for conflict detection
 */
function createBindingKey(key: string, modifiers: ModifierKey[]): string {
  const sortedMods = [...modifiers].sort();
  return `${sortedMods.join('+')}+${key}`;
}

/**
 * Convert default shortcuts to full bindings
 */
function createDefaultBindings(): ShortcutBinding[] {
  return DEFAULT_SHORTCUTS.map(s => ({
    ...s,
    customized: false,
    enabled: true,
  }));
}

// =============================================================================
// Store
// =============================================================================

export const useShortcutStore = create<ShortcutStore>()(
  devtools(
    persist(
      immer((set, get) => ({
        bindings: createDefaultBindings(),
        activePreset: 'default',
        isPanelOpen: false,

        updateBinding: (id, updates, allowConflict = false) => {
          const state = get();
          const binding = state.bindings.find(b => b.id === id);
          if (!binding) return null;

          // Check for conflicts if key or modifiers are being changed
          let conflict: ShortcutConflict | null = null;
          if (updates.key !== undefined || updates.modifiers !== undefined) {
            const newKey = updates.key ?? binding.key;
            const newModifiers = updates.modifiers ?? binding.modifiers;
            conflict = state.checkConflict(id, newKey, newModifiers);
            if (conflict && !allowConflict) return conflict;
          }

          set((draft) => {
            const idx = draft.bindings.findIndex(b => b.id === id);
            if (idx !== -1) {
              if (updates.key !== undefined) draft.bindings[idx].key = updates.key;
              if (updates.modifiers !== undefined) draft.bindings[idx].modifiers = updates.modifiers;
              if (updates.enabled !== undefined) draft.bindings[idx].enabled = updates.enabled;
              draft.bindings[idx].customized = true;
              draft.activePreset = null; // No longer using a preset
            }
          });

          return conflict;
        },

        resetBinding: (id) => {
          const defaultBinding = DEFAULT_SHORTCUTS.find(s => s.id === id);
          if (!defaultBinding) return;

          set((draft) => {
            const idx = draft.bindings.findIndex(b => b.id === id);
            if (idx !== -1) {
              draft.bindings[idx] = {
                ...defaultBinding,
                customized: false,
                enabled: true,
              };
            }
          });
        },

        resetAllBindings: () => {
          set((draft) => {
            draft.bindings = createDefaultBindings();
            draft.activePreset = 'default';
          });
        },

        applyPreset: (presetId) => {
          const preset = SHORTCUT_PRESETS.find(p => p.id === presetId);
          if (!preset) return;

          set((draft) => {
            draft.bindings = preset.bindings.map(s => ({
              ...s,
              customized: false,
              enabled: true,
            }));
            draft.activePreset = presetId;
          });
        },

        checkConflict: (id, key, modifiers) => {
          const state = get();
          const newBindingKey = createBindingKey(key, modifiers);

          for (const binding of state.bindings) {
            if (binding.id === id) continue; // Skip self
            if (!binding.enabled) continue; // Skip disabled bindings

            const existingKey = createBindingKey(binding.key, binding.modifiers);
            if (existingKey === newBindingKey) {
              return {
                existingBinding: binding,
                newBinding: { id, key, modifiers },
                conflictKey: newBindingKey,
              };
            }
          }

          return null;
        },

        getBindingByAction: (action) => {
          return get().bindings.find(b => b.action === action && b.enabled);
        },

        getBindingById: (id) => {
          return get().bindings.find(b => b.id === id);
        },

        getBindingsByCategory: (category) => {
          return get().bindings.filter(b => b.category === category);
        },

        togglePanel: () => {
          set((draft) => {
            draft.isPanelOpen = !draft.isPanelOpen;
          });
        },

        setPanelOpen: (open) => {
          set((draft) => {
            draft.isPanelOpen = open;
          });
        },

        exportBindings: () => {
          const state = get();
          return JSON.stringify({
            version: 1,
            bindings: state.bindings,
            activePreset: state.activePreset,
          }, null, 2);
        },

        importBindings: (json) => {
          try {
            const data = JSON.parse(json);
            if (data.version !== 1 || !Array.isArray(data.bindings)) {
              return false;
            }

            set((draft) => {
              draft.bindings = data.bindings;
              draft.activePreset = data.activePreset ?? null;
            });

            return true;
          } catch {
            return false;
          }
        },
      })),
      {
        name: 'openreelio-shortcuts',
        partialize: (state) => ({
          bindings: state.bindings,
          activePreset: state.activePreset,
        }),
      }
    ),
    { name: 'shortcut-store' }
  )
);

/**
 * Format shortcut for display
 */
export function formatShortcut(binding: ShortcutBinding): string {
  const parts: string[] = [];

  if (binding.modifiers.includes('ctrl')) parts.push('Ctrl');
  if (binding.modifiers.includes('shift')) parts.push('Shift');
  if (binding.modifiers.includes('alt')) parts.push('Alt');
  if (binding.modifiers.includes('meta')) parts.push('Cmd');

  // Format key for display
  let keyDisplay = binding.key;
  if (keyDisplay.startsWith('Key')) {
    keyDisplay = keyDisplay.slice(3);
  } else if (keyDisplay.startsWith('Digit')) {
    keyDisplay = keyDisplay.slice(5);
  } else if (keyDisplay === 'Space') {
    keyDisplay = 'Space';
  } else if (keyDisplay === 'ArrowLeft') {
    keyDisplay = '\u2190';
  } else if (keyDisplay === 'ArrowRight') {
    keyDisplay = '\u2192';
  } else if (keyDisplay === 'ArrowUp') {
    keyDisplay = '\u2191';
  } else if (keyDisplay === 'ArrowDown') {
    keyDisplay = '\u2193';
  } else if (keyDisplay === 'Equal') {
    keyDisplay = '+';
  } else if (keyDisplay === 'Minus') {
    keyDisplay = '-';
  } else if (keyDisplay === 'Slash') {
    keyDisplay = '/';
  } else if (keyDisplay === 'Backslash') {
    keyDisplay = '\\';
  }

  parts.push(keyDisplay);
  return parts.join('+');
}

export default useShortcutStore;

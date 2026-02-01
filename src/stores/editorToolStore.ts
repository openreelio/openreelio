/**
 * Editor Tool Store
 *
 * Manages the current editing tool mode (selection, razor, etc.)
 * and related tool-specific settings.
 *
 * @module stores/editorToolStore
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { devtools } from 'zustand/middleware';

// =============================================================================
// Types
// =============================================================================

/**
 * Available editing tools
 */
export type EditorTool =
  | 'select'    // Default selection tool (V)
  | 'razor'     // Split/cut clips at click position (C or B)
  | 'slip'      // Slip edit - adjust source range without moving clip
  | 'slide'     // Slide edit - move clip while adjusting neighbors
  | 'ripple'    // Ripple edit - move clip and shift all subsequent clips
  | 'roll'      // Roll edit - adjust edit point between two adjacent clips
  | 'hand';     // Pan/navigate timeline (H)

/**
 * Tool configuration and metadata
 */
export interface ToolConfig {
  id: EditorTool;
  label: string;
  shortcut: string;
  cursor: string;
  description: string;
}

/**
 * Clipboard item for copy/paste operations
 */
export interface ClipboardItem {
  type: 'clip';
  clipId: string;
  trackId: string;
  /** Serialized clip data for paste */
  clipData: {
    assetId: string;
    label?: string;
    timelineIn: number;
    sourceIn: number;
    sourceOut: number;
    speed: number;
    volume: number;
    opacity: number;
  };
}

/**
 * Editor tool store state
 */
interface EditorToolState {
  /** Currently active tool */
  activeTool: EditorTool;
  /** Previous tool (for temporary tool switch) */
  previousTool: EditorTool | null;
  /** Whether ripple editing is enabled */
  rippleEnabled: boolean;
  /** Whether auto-scroll (follow playhead) is enabled */
  autoScrollEnabled: boolean;
  /** Clipboard for copy/paste operations */
  clipboard: ClipboardItem[] | null;
}

/**
 * Editor tool store actions
 */
interface EditorToolActions {
  /** Set the active tool */
  setActiveTool: (tool: EditorTool) => void;
  /** Toggle to a tool temporarily (e.g., holding a key) */
  pushTool: (tool: EditorTool) => void;
  /** Return to previous tool after temporary switch */
  popTool: () => void;
  /** Toggle ripple editing mode */
  toggleRipple: () => void;
  /** Set ripple editing mode */
  setRippleEnabled: (enabled: boolean) => void;
  /** Toggle auto-scroll */
  toggleAutoScroll: () => void;
  /** Set auto-scroll enabled */
  setAutoScrollEnabled: (enabled: boolean) => void;
  /** Copy clips to clipboard */
  copyToClipboard: (items: ClipboardItem[]) => void;
  /** Clear clipboard */
  clearClipboard: () => void;
  /** Get clipboard contents */
  getClipboard: () => ClipboardItem[] | null;
  /** Reset to default state */
  reset: () => void;
}

export type EditorToolStore = EditorToolState & EditorToolActions;

// =============================================================================
// Constants
// =============================================================================

export const TOOL_CONFIGS: Record<EditorTool, ToolConfig> = {
  select: {
    id: 'select',
    label: 'Selection Tool',
    shortcut: 'V',
    cursor: 'default',
    description: 'Select and move clips',
  },
  razor: {
    id: 'razor',
    label: 'Razor Tool',
    shortcut: 'C',
    cursor: 'crosshair',
    description: 'Split clips at click position',
  },
  slip: {
    id: 'slip',
    label: 'Slip Tool',
    shortcut: 'Y',
    cursor: 'ew-resize',
    description: 'Adjust source range without moving clip',
  },
  slide: {
    id: 'slide',
    label: 'Slide Tool',
    shortcut: 'U',
    cursor: 'col-resize',
    description: 'Move clip while adjusting neighbors',
  },
  ripple: {
    id: 'ripple',
    label: 'Ripple Tool',
    shortcut: 'B',
    cursor: 'e-resize',
    description: 'Move clip and shift subsequent clips',
  },
  roll: {
    id: 'roll',
    label: 'Roll Tool',
    shortcut: 'N',
    cursor: 'col-resize',
    description: 'Adjust edit point between clips',
  },
  hand: {
    id: 'hand',
    label: 'Hand Tool',
    shortcut: 'H',
    cursor: 'grab',
    description: 'Pan and navigate timeline',
  },
};

// =============================================================================
// Initial State
// =============================================================================

const initialState: EditorToolState = {
  activeTool: 'select',
  previousTool: null,
  rippleEnabled: false,
  autoScrollEnabled: true,
  clipboard: null,
};

// =============================================================================
// Store
// =============================================================================

export const useEditorToolStore = create<EditorToolStore>()(
  devtools(
    immer((set, get) => ({
      ...initialState,

      setActiveTool: (tool: EditorTool) => {
        set((state) => {
          state.activeTool = tool;
          state.previousTool = null;
        });
      },

      pushTool: (tool: EditorTool) => {
        set((state) => {
          if (state.previousTool === null) {
            state.previousTool = state.activeTool;
          }
          state.activeTool = tool;
        });
      },

      popTool: () => {
        set((state) => {
          if (state.previousTool !== null) {
            state.activeTool = state.previousTool;
            state.previousTool = null;
          }
        });
      },

      toggleRipple: () => {
        set((state) => {
          state.rippleEnabled = !state.rippleEnabled;
        });
      },

      setRippleEnabled: (enabled: boolean) => {
        set((state) => {
          state.rippleEnabled = enabled;
        });
      },

      toggleAutoScroll: () => {
        set((state) => {
          state.autoScrollEnabled = !state.autoScrollEnabled;
        });
      },

      setAutoScrollEnabled: (enabled: boolean) => {
        set((state) => {
          state.autoScrollEnabled = enabled;
        });
      },

      copyToClipboard: (items: ClipboardItem[]) => {
        set((state) => {
          state.clipboard = items;
        });
      },

      clearClipboard: () => {
        set((state) => {
          state.clipboard = null;
        });
      },

      getClipboard: () => {
        return get().clipboard;
      },

      reset: () => {
        set(() => ({ ...initialState }));
      },
    })),
    { name: 'editor-tool-store' }
  )
);

/**
 * Helper hook to get cursor style for current tool
 */
export function getToolCursor(tool: EditorTool, isDragging = false): string {
  if (isDragging) {
    if (tool === 'hand') return 'grabbing';
    return 'grabbing';
  }
  return TOOL_CONFIGS[tool].cursor;
}

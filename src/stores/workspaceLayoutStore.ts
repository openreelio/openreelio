/**
 * Workspace Layout Store
 *
 * Manages dockable panel layout state with persistence.
 * Tracks which panels are in which dock zones, zone sizes,
 * active tabs, and collapse states.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { isVideoGenerationEnabled } from '@/config/featureFlags';

// =============================================================================
// Types
// =============================================================================

/** Unique identifier for each dockable panel in the editor */
export type PanelId =
  | 'explorer'
  | 'source-monitor'
  | 'program-monitor'
  | 'timeline'
  | 'timeline-index'
  | 'terminal'
  | 'effects-browser'
  | 'inspector'
  | 'ai-assistant'
  | 'agent-review'
  | 'audio-mixer'
  | 'history'
  | 'transcript'
  | 'performance'
  | 'scopes'
  | 'comparison'
  | 'generation';

/** Dock zone identifiers — fixed regions of the editor layout */
export type DockZoneId = 'left' | 'center-top' | 'center-bottom' | 'right' | 'bottom';

/** Configuration for a single dock zone */
export interface DockZone {
  /** Ordered list of panel IDs in this zone (tab order) */
  panelIds: PanelId[];
  /** Currently visible panel (active tab) */
  activePanelId: PanelId | null;
  /** Whether the zone is collapsed */
  collapsed: boolean;
}

/** Size configuration for resizable zones (pixels) */
export interface ZoneSizes {
  leftWidth: number;
  rightWidth: number;
  /** Ratio of center-top height to total center height (0.0 - 1.0) */
  centerSplitRatio: number;
  bottomHeight: number;
}

/** Complete workspace layout state */
export interface WorkspaceLayout {
  zones: Record<DockZoneId, DockZone>;
  sizes: ZoneSizes;
}

/** Panel display metadata */
export interface PanelMeta {
  id: PanelId;
  label: string;
  icon: string;
  /** Minimum width when in a side zone */
  minWidth?: number;
  /** Minimum height when in a bottom zone */
  minHeight?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Panel metadata registry */
export const PANEL_REGISTRY: Record<PanelId, PanelMeta> = {
  explorer: { id: 'explorer', label: 'Project Explorer', icon: 'FolderOpen', minWidth: 200 },
  'source-monitor': {
    id: 'source-monitor',
    label: 'Source Monitor',
    icon: 'Monitor',
    minWidth: 300,
  },
  'program-monitor': {
    id: 'program-monitor',
    label: 'Program Monitor',
    icon: 'Play',
    minWidth: 300,
  },
  timeline: { id: 'timeline', label: 'Timeline', icon: 'Film', minHeight: 120 },
  'timeline-index': {
    id: 'timeline-index',
    label: 'Timeline Index',
    icon: 'ListFilter',
    minHeight: 80,
  },
  terminal: { id: 'terminal', label: 'Terminal', icon: 'Terminal', minHeight: 140 },
  'effects-browser': { id: 'effects-browser', label: 'Effects', icon: 'Wand2', minWidth: 240 },
  inspector: { id: 'inspector', label: 'Inspector', icon: 'SlidersHorizontal', minWidth: 240 },
  'ai-assistant': { id: 'ai-assistant', label: 'AI Assistant', icon: 'Sparkles', minWidth: 280 },
  'agent-review': {
    id: 'agent-review',
    label: 'Agent Review',
    icon: 'ClipboardList',
    minHeight: 120,
  },
  'audio-mixer': { id: 'audio-mixer', label: 'Audio Mixer', icon: 'Sliders', minHeight: 100 },
  history: { id: 'history', label: 'History', icon: 'History', minHeight: 80 },
  transcript: { id: 'transcript', label: 'Transcript', icon: 'FileText', minHeight: 80 },
  performance: { id: 'performance', label: 'Performance', icon: 'Activity', minHeight: 80 },
  scopes: { id: 'scopes', label: 'Scopes', icon: 'Activity', minWidth: 260, minHeight: 120 },
  comparison: { id: 'comparison', label: 'Comparison', icon: 'GitCompareArrows', minHeight: 80 },
  generation: { id: 'generation', label: 'Generate', icon: 'Sparkles', minHeight: 80 },
};

/** Default zone sizes */
const DEFAULT_SIZES: ZoneSizes = {
  leftWidth: 260,
  rightWidth: 288,
  centerSplitRatio: 0.5,
  bottomHeight: 144,
};

/** Minimum zone sizes to prevent collapse below usable thresholds */
export const MIN_ZONE_SIZES = {
  sidebarWidth: 180,
  bottomHeight: 80,
  centerSplitMin: 0.2,
  centerSplitMax: 0.8,
} as const;

const DEFAULT_BOTTOM_PANEL_IDS: PanelId[] = ['timeline-index', 'history', 'transcript'];
const DEFAULT_BOTTOM_ACTIVE_PANEL: PanelId = 'timeline-index';
const NON_PERSISTED_PANEL_IDS = new Set<PanelId>(['terminal', 'agent-review']);
const INTERNAL_ONLY_PANEL_IDS = new Set<PanelId>(['agent-review']);

/** Maximum zone sizes */
export const MAX_ZONE_SIZES = {
  sidebarWidth: 600,
  bottomHeight: 500,
} as const;

/** Default layout matching the current EditorView arrangement */
export function createDefaultLayout(): WorkspaceLayout {
  return {
    zones: {
      left: {
        panelIds: ['explorer'],
        activePanelId: 'explorer',
        collapsed: false,
      },
      'center-top': {
        panelIds: ['source-monitor', 'program-monitor'],
        activePanelId: 'source-monitor',
        collapsed: false,
      },
      'center-bottom': {
        panelIds: ['timeline'],
        activePanelId: 'timeline',
        collapsed: false,
      },
      right: {
        panelIds: ['inspector', 'ai-assistant'],
        activePanelId: 'inspector',
        collapsed: false,
      },
      bottom: {
        panelIds: [...DEFAULT_BOTTOM_PANEL_IDS],
        activePanelId: DEFAULT_BOTTOM_ACTIVE_PANEL,
        collapsed: true,
      },
    },
    sizes: { ...DEFAULT_SIZES },
  };
}

// =============================================================================
// Workspace Presets
// =============================================================================

/** A saved workspace preset (built-in or custom) */
export interface WorkspacePreset {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Short description of the workspace purpose */
  description: string;
  /** The complete layout configuration */
  layout: WorkspaceLayout;
  /** Whether this is a built-in (non-deletable) preset */
  builtIn: boolean;
}

/** Built-in workspace presets optimized for different editing workflows */
export const WORKSPACE_PRESETS: WorkspacePreset[] = [
  {
    id: 'editing',
    name: 'Editing',
    description: 'Timeline-focused layout for general editing workflow',
    builtIn: true,
    layout: {
      zones: {
        left: { panelIds: ['explorer'], activePanelId: 'explorer', collapsed: false },
        'center-top': {
          panelIds: ['source-monitor', 'program-monitor'],
          activePanelId: 'source-monitor',
          collapsed: false,
        },
        'center-bottom': { panelIds: ['timeline'], activePanelId: 'timeline', collapsed: false },
        right: {
          panelIds: ['inspector', 'ai-assistant'],
          activePanelId: 'inspector',
          collapsed: false,
        },
        bottom: {
          panelIds: [...DEFAULT_BOTTOM_PANEL_IDS],
          activePanelId: DEFAULT_BOTTOM_ACTIVE_PANEL,
          collapsed: true,
        },
      },
      sizes: { leftWidth: 240, rightWidth: 280, centerSplitRatio: 0.4, bottomHeight: 200 },
    },
  },
  {
    id: 'color',
    name: 'Color',
    description: 'Color grading layout with large preview and comparison tools',
    builtIn: true,
    layout: {
      zones: {
        left: { panelIds: [], activePanelId: null, collapsed: true },
        'center-top': {
          panelIds: ['program-monitor'],
          activePanelId: 'program-monitor',
          collapsed: false,
        },
        'center-bottom': { panelIds: ['timeline'], activePanelId: 'timeline', collapsed: false },
        right: {
          panelIds: ['scopes', 'inspector', 'comparison'],
          activePanelId: 'scopes',
          collapsed: false,
        },
        bottom: {
          panelIds: [...DEFAULT_BOTTOM_PANEL_IDS],
          activePanelId: DEFAULT_BOTTOM_ACTIVE_PANEL,
          collapsed: true,
        },
      },
      sizes: { leftWidth: 260, rightWidth: 380, centerSplitRatio: 0.55, bottomHeight: 200 },
    },
  },
  {
    id: 'audio',
    name: 'Audio',
    description: 'Audio editing layout with mixer and meters',
    builtIn: true,
    layout: {
      zones: {
        left: { panelIds: ['audio-mixer'], activePanelId: 'audio-mixer', collapsed: false },
        'center-top': {
          panelIds: ['program-monitor'],
          activePanelId: 'program-monitor',
          collapsed: false,
        },
        'center-bottom': { panelIds: ['timeline'], activePanelId: 'timeline', collapsed: false },
        right: {
          panelIds: ['inspector'],
          activePanelId: 'inspector',
          collapsed: false,
        },
        bottom: {
          panelIds: [...DEFAULT_BOTTOM_PANEL_IDS],
          activePanelId: DEFAULT_BOTTOM_ACTIVE_PANEL,
          collapsed: true,
        },
      },
      sizes: { leftWidth: 280, rightWidth: 280, centerSplitRatio: 0.45, bottomHeight: 200 },
    },
  },
  {
    id: 'effects',
    name: 'Effects',
    description: 'Effects editing layout with inspector and AI assistant',
    builtIn: true,
    layout: {
      zones: {
        left: {
          panelIds: ['effects-browser', 'explorer'],
          activePanelId: 'effects-browser',
          collapsed: false,
        },
        'center-top': {
          panelIds: ['program-monitor'],
          activePanelId: 'program-monitor',
          collapsed: false,
        },
        'center-bottom': { panelIds: ['timeline'], activePanelId: 'timeline', collapsed: false },
        right: {
          panelIds: ['inspector', 'ai-assistant'],
          activePanelId: 'inspector',
          collapsed: false,
        },
        bottom: {
          panelIds: [...DEFAULT_BOTTOM_PANEL_IDS],
          activePanelId: DEFAULT_BOTTOM_ACTIVE_PANEL,
          collapsed: true,
        },
      },
      sizes: { leftWidth: 300, rightWidth: 340, centerSplitRatio: 0.5, bottomHeight: 200 },
    },
  },
  {
    id: 'assembly',
    name: 'Assembly',
    description: 'Assembly layout with large preview and explorer for rough cuts',
    builtIn: true,
    layout: {
      zones: {
        left: { panelIds: ['explorer'], activePanelId: 'explorer', collapsed: false },
        'center-top': {
          panelIds: ['source-monitor', 'program-monitor'],
          activePanelId: 'program-monitor',
          collapsed: false,
        },
        'center-bottom': { panelIds: ['timeline'], activePanelId: 'timeline', collapsed: false },
        right: { panelIds: [], activePanelId: null, collapsed: true },
        bottom: {
          panelIds: ['history'],
          activePanelId: 'history',
          collapsed: true,
        },
      },
      sizes: { leftWidth: 300, rightWidth: 288, centerSplitRatio: 0.65, bottomHeight: 144 },
    },
  },
];

/** Find a workspace preset by ID (built-in or custom) */
export function findPreset(
  presetId: string,
  customPresets: WorkspacePreset[],
): WorkspacePreset | undefined {
  return (
    WORKSPACE_PRESETS.find((p) => p.id === presetId) ?? customPresets.find((p) => p.id === presetId)
  );
}

// =============================================================================
// Store State & Actions
// =============================================================================

interface WorkspaceLayoutState {
  /** Current active layout */
  layout: WorkspaceLayout;
  /** Whether a panel drag is in progress */
  isDragging: boolean;
  /** Panel being dragged (null when not dragging) */
  draggedPanelId: PanelId | null;
  /** Currently active preset ID (null if layout was manually modified) */
  activePresetId: string | null;
  /** User-saved custom workspace presets */
  customPresets: WorkspacePreset[];
}

interface WorkspaceLayoutActions {
  /** Move a panel from its current zone to a target zone */
  movePanel: (panelId: PanelId, targetZoneId: DockZoneId) => void;
  /** Remove a panel from its current zone without deleting its content definition */
  hidePanel: (panelId: PanelId) => void;
  /** Restore a panel into the layout when it is missing from all zones */
  restorePanel: (panelId: PanelId, targetZoneId?: DockZoneId) => void;
  /** Set the active (visible) panel in a zone */
  setActivePanel: (zoneId: DockZoneId, panelId: PanelId) => void;
  /** Toggle zone collapsed state */
  toggleZoneCollapse: (zoneId: DockZoneId) => void;
  /** Set zone collapsed state explicitly */
  setZoneCollapsed: (zoneId: DockZoneId, collapsed: boolean) => void;
  /** Resize left sidebar width */
  setLeftWidth: (width: number) => void;
  /** Resize right sidebar width */
  setRightWidth: (width: number) => void;
  /** Set center split ratio (top vs bottom) */
  setCenterSplitRatio: (ratio: number) => void;
  /** Resize bottom panel height */
  setBottomHeight: (height: number) => void;
  /** Start dragging a panel */
  startDrag: (panelId: PanelId) => void;
  /** End panel drag */
  endDrag: () => void;
  /** Reset to default layout */
  resetLayout: () => void;
  /** Clear transient drag state without resetting the persisted layout */
  clearTransientState: () => void;
  /** Apply a workspace preset by ID */
  applyPreset: (presetId: string) => void;
  /** Save the current layout as a custom preset */
  saveCustomPreset: (name: string, description?: string) => string;
  /** Delete a custom preset (built-in presets cannot be deleted) */
  deleteCustomPreset: (presetId: string) => boolean;
  /** Rename a custom preset */
  renameCustomPreset: (presetId: string, name: string) => boolean;
}

export type WorkspaceLayoutStore = WorkspaceLayoutState & WorkspaceLayoutActions;

// =============================================================================
// Helpers
// =============================================================================

/** Clamp a value between min and max */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Find which zone a panel currently belongs to */
export function findPanelZone(layout: WorkspaceLayout, panelId: PanelId): DockZoneId | null {
  for (const [zoneId, zone] of Object.entries(layout.zones)) {
    if (zone.panelIds.includes(panelId)) {
      return zoneId as DockZoneId;
    }
  }
  return null;
}

export function revealWorkspacePanel(
  panelId: PanelId,
  defaultZoneId: DockZoneId,
  options: { moveToDefaultZone?: boolean } = {},
): DockZoneId | null {
  if (INTERNAL_ONLY_PANEL_IDS.has(panelId)) {
    return null;
  }

  let store = useWorkspaceLayoutStore.getState();
  let targetZoneId = findPanelZone(store.layout, panelId);

  if (options.moveToDefaultZone && targetZoneId && targetZoneId !== defaultZoneId) {
    store.hidePanel(panelId);
    store = useWorkspaceLayoutStore.getState();
    targetZoneId = null;
  }

  if (!targetZoneId) {
    store.restorePanel(panelId, defaultZoneId);
    store = useWorkspaceLayoutStore.getState();
    targetZoneId = findPanelZone(store.layout, panelId);
  }

  if (!targetZoneId) {
    return null;
  }

  store.setActivePanel(targetZoneId, panelId);
  store.setZoneCollapsed(targetZoneId, false);
  return targetZoneId;
}

function normalizeZone(zone: DockZone): void {
  const seen = new Set<PanelId>();
  const videoGenerationEnabled = isVideoGenerationEnabled();

  zone.panelIds = zone.panelIds.filter((panelId): panelId is PanelId => {
    if (!(panelId in PANEL_REGISTRY)) {
      return false;
    }
    if (panelId === 'generation' && !videoGenerationEnabled) {
      return false;
    }
    if (NON_PERSISTED_PANEL_IDS.has(panelId)) {
      return false;
    }
    if (seen.has(panelId)) {
      return false;
    }
    seen.add(panelId);
    return true;
  });

  if (zone.activePanelId && !zone.panelIds.includes(zone.activePanelId)) {
    zone.activePanelId = zone.panelIds[0] ?? null;
  }
}

function ensurePanelInLayout(
  layout: WorkspaceLayout,
  panelId: PanelId,
  targetZoneId: DockZoneId = 'right',
): DockZoneId {
  const existingZoneId = findPanelZone(layout, panelId);
  if (existingZoneId) {
    return existingZoneId;
  }

  const targetZone = layout.zones[targetZoneId];
  if (!targetZone.panelIds.includes(panelId)) {
    targetZone.panelIds.push(panelId);
  }
  if (!targetZone.activePanelId) {
    targetZone.activePanelId = panelId;
  }

  return targetZoneId;
}

function normalizeWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayout {
  const normalized = JSON.parse(JSON.stringify(layout)) as WorkspaceLayout;

  for (const zone of Object.values(normalized.zones)) {
    normalizeZone(zone);
    if (zone.activePanelId && NON_PERSISTED_PANEL_IDS.has(zone.activePanelId)) {
      zone.activePanelId = zone.panelIds[0] ?? null;
    }
  }

  ensurePanelInLayout(normalized, 'ai-assistant', 'right');

  return normalized;
}

function normalizeCustomPresets(customPresets: WorkspacePreset[] | undefined): WorkspacePreset[] {
  return (customPresets ?? []).map((preset) => ({
    ...preset,
    layout: normalizeWorkspaceLayout(preset.layout),
  }));
}

// =============================================================================
// Store
// =============================================================================

export const useWorkspaceLayoutStore = create<WorkspaceLayoutStore>()(
  persist(
    immer((set, get) => ({
      // Initial state
      layout: normalizeWorkspaceLayout(createDefaultLayout()),
      isDragging: false,
      draggedPanelId: null,
      activePresetId: null,
      customPresets: [],

      // Actions
      movePanel: (panelId, targetZoneId) => {
        set((state) => {
          const sourceZoneId = findPanelZone(state.layout, panelId);
          if (!sourceZoneId || sourceZoneId === targetZoneId) return;

          const sourceZone = state.layout.zones[sourceZoneId];
          const targetZone = state.layout.zones[targetZoneId];

          // Remove from source zone
          sourceZone.panelIds = sourceZone.panelIds.filter((id) => id !== panelId);

          // Update source zone active panel if the moved panel was active
          if (sourceZone.activePanelId === panelId) {
            sourceZone.activePanelId = sourceZone.panelIds[0] ?? null;
          }

          // Add to target zone
          targetZone.panelIds.push(panelId);

          // Make the moved panel active in the target zone
          targetZone.activePanelId = panelId;

          // Expand target zone if collapsed
          if (targetZone.collapsed) {
            targetZone.collapsed = false;
          }

          // Structural change clears active preset
          state.activePresetId = null;
        });
      },

      hidePanel: (panelId) => {
        set((state) => {
          const sourceZoneId = findPanelZone(state.layout, panelId);
          if (!sourceZoneId) {
            return;
          }

          const sourceZone = state.layout.zones[sourceZoneId];
          sourceZone.panelIds = sourceZone.panelIds.filter((id) => id !== panelId);

          if (sourceZone.activePanelId === panelId) {
            sourceZone.activePanelId = sourceZone.panelIds[0] ?? null;
          }

          state.activePresetId = null;
        });
      },

      restorePanel: (panelId, targetZoneId = 'right') => {
        set((state) => {
          if (INTERNAL_ONLY_PANEL_IDS.has(panelId)) {
            return;
          }

          if (panelId === 'generation' && !isVideoGenerationEnabled()) {
            return;
          }

          const existingZoneId = findPanelZone(state.layout, panelId);
          if (existingZoneId) {
            return;
          }

          const zone = state.layout.zones[targetZoneId];
          if (!zone.panelIds.includes(panelId)) {
            zone.panelIds.push(panelId);
          }
          if (!zone.activePanelId) {
            zone.activePanelId = panelId;
          }
          state.activePresetId = null;
        });
      },

      setActivePanel: (zoneId, panelId) => {
        set((state) => {
          const zone = state.layout.zones[zoneId];
          if (zone.panelIds.includes(panelId)) {
            zone.activePanelId = panelId;
          }
        });
      },

      toggleZoneCollapse: (zoneId) => {
        set((state) => {
          state.layout.zones[zoneId].collapsed = !state.layout.zones[zoneId].collapsed;
          state.activePresetId = null;
        });
      },

      setZoneCollapsed: (zoneId, collapsed) => {
        set((state) => {
          state.layout.zones[zoneId].collapsed = collapsed;
          state.activePresetId = null;
        });
      },

      setLeftWidth: (width) => {
        set((state) => {
          state.layout.sizes.leftWidth = clamp(
            width,
            MIN_ZONE_SIZES.sidebarWidth,
            MAX_ZONE_SIZES.sidebarWidth,
          );
          state.activePresetId = null;
        });
      },

      setRightWidth: (width) => {
        set((state) => {
          state.layout.sizes.rightWidth = clamp(
            width,
            MIN_ZONE_SIZES.sidebarWidth,
            MAX_ZONE_SIZES.sidebarWidth,
          );
          state.activePresetId = null;
        });
      },

      setCenterSplitRatio: (ratio) => {
        set((state) => {
          state.layout.sizes.centerSplitRatio = clamp(
            ratio,
            MIN_ZONE_SIZES.centerSplitMin,
            MIN_ZONE_SIZES.centerSplitMax,
          );
          state.activePresetId = null;
        });
      },

      setBottomHeight: (height) => {
        set((state) => {
          state.layout.sizes.bottomHeight = clamp(
            height,
            MIN_ZONE_SIZES.bottomHeight,
            MAX_ZONE_SIZES.bottomHeight,
          );
          state.activePresetId = null;
        });
      },

      startDrag: (panelId) => {
        set((state) => {
          state.isDragging = true;
          state.draggedPanelId = panelId;
        });
      },

      endDrag: () => {
        set((state) => {
          state.isDragging = false;
          state.draggedPanelId = null;
        });
      },

      resetLayout: () => {
        set((state) => {
          const defaultLayout = normalizeWorkspaceLayout(createDefaultLayout());
          state.layout = defaultLayout;
          state.isDragging = false;
          state.draggedPanelId = null;
          state.activePresetId = null;
        });
      },

      clearTransientState: () => {
        set((state) => {
          state.isDragging = false;
          state.draggedPanelId = null;
        });
      },

      applyPreset: (presetId) => {
        set((state) => {
          const preset = findPreset(presetId, state.customPresets);
          if (!preset) return;

          // Deep copy the preset layout to avoid shared references
          state.layout = normalizeWorkspaceLayout(preset.layout);
          state.activePresetId = presetId;
          state.isDragging = false;
          state.draggedPanelId = null;
        });
      },

      saveCustomPreset: (name, description) => {
        const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        set((state) => {
          const preset: WorkspacePreset = {
            id,
            name,
            description: description ?? '',
            layout: JSON.parse(JSON.stringify(state.layout)),
            builtIn: false,
          };
          state.customPresets.push(preset);
          state.activePresetId = id;
        });
        return id;
      },

      deleteCustomPreset: (presetId) => {
        // Cannot delete built-in presets
        if (WORKSPACE_PRESETS.some((p) => p.id === presetId)) return false;

        // Check existence before mutating
        if (!get().customPresets.some((p) => p.id === presetId)) return false;

        set((s) => {
          // Find index inside the draft to avoid stale-index bugs
          const idx = s.customPresets.findIndex((p) => p.id === presetId);
          if (idx !== -1) {
            s.customPresets.splice(idx, 1);
          }
          if (s.activePresetId === presetId) {
            s.activePresetId = null;
          }
        });
        return true;
      },

      renameCustomPreset: (presetId, name) => {
        if (!get().customPresets.some((p) => p.id === presetId)) return false;

        set((s) => {
          const preset = s.customPresets.find((p) => p.id === presetId);
          if (preset) {
            preset.name = name;
          }
        });
        return true;
      },
    })),
    {
      name: 'openreelio-workspace-layout',
      version: 3,
      partialize: (state) => ({
        layout: normalizeWorkspaceLayout(state.layout),
        activePresetId: state.activePresetId ?? null,
        customPresets: normalizeCustomPresets(state.customPresets),
      }),
      migrate: (persisted, version) => {
        if (version === 1) {
          // v1 only had layout — add preset fields
          const state = persisted as { layout: WorkspaceLayout };
          return {
            ...state,
            layout: normalizeWorkspaceLayout(state.layout),
            activePresetId: null,
            customPresets: [],
          };
        }

        if (persisted && typeof persisted === 'object' && 'layout' in persisted) {
          const state = persisted as {
            layout: WorkspaceLayout;
            activePresetId?: string | null;
            customPresets?: WorkspacePreset[];
          };
          return {
            ...state,
            layout: normalizeWorkspaceLayout(state.layout),
            activePresetId: state.activePresetId ?? null,
            customPresets: normalizeCustomPresets(state.customPresets),
          };
        }
        return persisted;
      },
    },
  ),
);

// =============================================================================
// Selectors
// =============================================================================

export const selectLayout = (state: WorkspaceLayoutStore): WorkspaceLayout => state.layout;
export const selectZone =
  (zoneId: DockZoneId) =>
  (state: WorkspaceLayoutStore): DockZone =>
    state.layout.zones[zoneId];
export const selectZoneSizes = (state: WorkspaceLayoutStore): ZoneSizes => state.layout.sizes;
export const selectIsDragging = (state: WorkspaceLayoutStore): boolean => state.isDragging;
export const selectDraggedPanelId = (state: WorkspaceLayoutStore): PanelId | null =>
  state.draggedPanelId;
export const selectActivePresetId = (state: WorkspaceLayoutStore): string | null =>
  state.activePresetId;
export const selectCustomPresets = (state: WorkspaceLayoutStore): WorkspacePreset[] =>
  state.customPresets;
/** All available presets (built-in + custom) */
export const selectAllPresets = (state: WorkspaceLayoutStore): WorkspacePreset[] => [
  ...WORKSPACE_PRESETS,
  ...state.customPresets,
];

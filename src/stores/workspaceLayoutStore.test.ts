/**
 * Workspace Layout Store Tests
 *
 * BDD-style tests for the dockable panel layout system store.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useWorkspaceLayoutStore,
  createDefaultLayout,
  findPanelZone,
  findPreset,
  revealWorkspacePanel,
  WORKSPACE_PRESETS,
  MIN_ZONE_SIZES,
  MAX_ZONE_SIZES,
  type WorkspaceLayout,
  type WorkspacePreset,
} from './workspaceLayoutStore';

describe('WorkspaceLayoutStore', () => {
  beforeEach(() => {
    useWorkspaceLayoutStore.getState().resetLayout();
    // Clear custom presets for test isolation (resetLayout preserves them by design)
    useWorkspaceLayoutStore.setState({ customPresets: [] });
  });

  describe('default layout', () => {
    it('should initialize with explorer in left zone', () => {
      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.left.panelIds).toContain('explorer');
      expect(layout.zones.left.activePanelId).toBe('explorer');
    });

    it('should initialize with monitors in center-top zone', () => {
      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones['center-top'].panelIds).toEqual(['source-monitor', 'program-monitor']);
      expect(layout.zones['center-top'].activePanelId).toBe('source-monitor');
    });

    it('should initialize with timeline in center-bottom zone', () => {
      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones['center-bottom'].panelIds).toEqual(['timeline']);
      expect(layout.zones['center-bottom'].activePanelId).toBe('timeline');
    });

    it('should initialize with inspector and AI in right zone', () => {
      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.right.panelIds).toContain('inspector');
      expect(layout.zones.right.panelIds).toContain('ai-assistant');
    });

    it('should initialize bottom zone collapsed by default', () => {
      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.bottom.collapsed).toBe(true);
      expect(layout.zones.bottom.panelIds.length).toBeGreaterThan(0);
    });

    it('should have correct default zone sizes', () => {
      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.sizes.leftWidth).toBe(260);
      expect(layout.sizes.rightWidth).toBe(288);
      expect(layout.sizes.centerSplitRatio).toBe(0.5);
      expect(layout.sizes.bottomHeight).toBe(144);
    });
  });

  describe('movePanel', () => {
    it('should move panel from source zone to target zone', () => {
      const store = useWorkspaceLayoutStore.getState();
      store.movePanel('explorer', 'right');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.left.panelIds).not.toContain('explorer');
      expect(layout.zones.right.panelIds).toContain('explorer');
    });

    it('should make moved panel active in target zone', () => {
      const store = useWorkspaceLayoutStore.getState();
      store.movePanel('explorer', 'right');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.right.activePanelId).toBe('explorer');
    });

    it('should update source zone active panel when active panel is moved', () => {
      const store = useWorkspaceLayoutStore.getState();
      // explorer is the active panel in left zone
      store.movePanel('explorer', 'bottom');

      const { layout } = useWorkspaceLayoutStore.getState();
      // Left zone should have no active panel (no panels left)
      expect(layout.zones.left.activePanelId).toBeNull();
    });

    it('should expand collapsed target zone when panel is moved into it', () => {
      const store = useWorkspaceLayoutStore.getState();
      // Bottom is collapsed by default
      expect(store.layout.zones.bottom.collapsed).toBe(true);

      store.movePanel('explorer', 'bottom');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.bottom.collapsed).toBe(false);
    });

    it('should not move panel to same zone', () => {
      const store = useWorkspaceLayoutStore.getState();
      const before = [...store.layout.zones.left.panelIds];
      store.movePanel('explorer', 'left');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.left.panelIds).toEqual(before);
    });
  });

  describe('setActivePanel', () => {
    it('should set active panel in zone', () => {
      const store = useWorkspaceLayoutStore.getState();
      store.setActivePanel('center-top', 'program-monitor');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones['center-top'].activePanelId).toBe('program-monitor');
    });

    it('should not set active panel if panel is not in zone', () => {
      const store = useWorkspaceLayoutStore.getState();
      store.setActivePanel('left', 'timeline');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.left.activePanelId).toBe('explorer');
    });

    it('should restore the terminal panel into the bottom zone when requested', () => {
      const store = useWorkspaceLayoutStore.getState();
      store.restorePanel('terminal', 'bottom');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.bottom.panelIds).toContain('terminal');
    });

    it('should not restore the internal agent review panel into the dock layout', () => {
      const store = useWorkspaceLayoutStore.getState();
      store.restorePanel('agent-review', 'bottom');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.bottom.panelIds).not.toContain('agent-review');
      expect(layout.zones.bottom.activePanelId).toBe('history');
    });

    it('should hide a panel and update the active tab when removed', () => {
      const store = useWorkspaceLayoutStore.getState();
      store.restorePanel('terminal', 'bottom');
      store.setActivePanel('bottom', 'terminal');

      store.hidePanel('terminal');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.bottom.panelIds).not.toContain('terminal');
      expect(layout.zones.bottom.activePanelId).toBe('history');
    });
  });

  describe('zone collapse', () => {
    it('should toggle zone collapse state', () => {
      const store = useWorkspaceLayoutStore.getState();
      expect(store.layout.zones.left.collapsed).toBe(false);

      store.toggleZoneCollapse('left');
      expect(useWorkspaceLayoutStore.getState().layout.zones.left.collapsed).toBe(true);

      store.toggleZoneCollapse('left');
      expect(useWorkspaceLayoutStore.getState().layout.zones.left.collapsed).toBe(false);
    });

    it('should set zone collapsed explicitly', () => {
      const store = useWorkspaceLayoutStore.getState();
      store.setZoneCollapsed('right', true);

      expect(useWorkspaceLayoutStore.getState().layout.zones.right.collapsed).toBe(true);
    });
  });

  describe('zone resizing', () => {
    it('should clamp left width within bounds', () => {
      const store = useWorkspaceLayoutStore.getState();

      store.setLeftWidth(100); // Below minimum
      expect(useWorkspaceLayoutStore.getState().layout.sizes.leftWidth).toBe(
        MIN_ZONE_SIZES.sidebarWidth,
      );

      store.setLeftWidth(1000); // Above maximum
      expect(useWorkspaceLayoutStore.getState().layout.sizes.leftWidth).toBe(
        MAX_ZONE_SIZES.sidebarWidth,
      );

      store.setLeftWidth(300); // Normal value
      expect(useWorkspaceLayoutStore.getState().layout.sizes.leftWidth).toBe(300);
    });

    it('should clamp right width within bounds', () => {
      const store = useWorkspaceLayoutStore.getState();

      store.setRightWidth(50);
      expect(useWorkspaceLayoutStore.getState().layout.sizes.rightWidth).toBe(
        MIN_ZONE_SIZES.sidebarWidth,
      );

      store.setRightWidth(400);
      expect(useWorkspaceLayoutStore.getState().layout.sizes.rightWidth).toBe(400);
    });

    it('should clamp center split ratio within bounds', () => {
      const store = useWorkspaceLayoutStore.getState();

      store.setCenterSplitRatio(0.1); // Below min
      expect(useWorkspaceLayoutStore.getState().layout.sizes.centerSplitRatio).toBe(
        MIN_ZONE_SIZES.centerSplitMin,
      );

      store.setCenterSplitRatio(0.9); // Above max
      expect(useWorkspaceLayoutStore.getState().layout.sizes.centerSplitRatio).toBe(
        MIN_ZONE_SIZES.centerSplitMax,
      );

      store.setCenterSplitRatio(0.6);
      expect(useWorkspaceLayoutStore.getState().layout.sizes.centerSplitRatio).toBe(0.6);
    });

    it('should clamp bottom height within bounds', () => {
      const store = useWorkspaceLayoutStore.getState();

      store.setBottomHeight(10);
      expect(useWorkspaceLayoutStore.getState().layout.sizes.bottomHeight).toBe(
        MIN_ZONE_SIZES.bottomHeight,
      );

      store.setBottomHeight(800);
      expect(useWorkspaceLayoutStore.getState().layout.sizes.bottomHeight).toBe(
        MAX_ZONE_SIZES.bottomHeight,
      );
    });
  });

  describe('drag state', () => {
    it('should track drag state', () => {
      const store = useWorkspaceLayoutStore.getState();
      expect(store.isDragging).toBe(false);
      expect(store.draggedPanelId).toBeNull();

      store.startDrag('explorer');
      const after = useWorkspaceLayoutStore.getState();
      expect(after.isDragging).toBe(true);
      expect(after.draggedPanelId).toBe('explorer');

      store.endDrag();
      const ended = useWorkspaceLayoutStore.getState();
      expect(ended.isDragging).toBe(false);
      expect(ended.draggedPanelId).toBeNull();
    });
  });

  describe('resetLayout', () => {
    it('should restore default layout after modifications', () => {
      const store = useWorkspaceLayoutStore.getState();
      const defaultLayout = createDefaultLayout();

      // Make changes
      store.movePanel('explorer', 'right');
      store.setLeftWidth(400);
      store.toggleZoneCollapse('right');

      // Reset
      store.resetLayout();

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(layout.zones.left.panelIds).toEqual(defaultLayout.zones.left.panelIds);
      expect(layout.sizes.leftWidth).toBe(defaultLayout.sizes.leftWidth);
      expect(layout.zones.right.collapsed).toBe(defaultLayout.zones.right.collapsed);
    });
  });

  describe('findPanelZone', () => {
    it('should find the zone containing a panel', () => {
      const layout = createDefaultLayout();
      expect(findPanelZone(layout, 'explorer')).toBe('left');
      expect(findPanelZone(layout, 'timeline')).toBe('center-bottom');
      expect(findPanelZone(layout, 'history')).toBe('bottom');
    });

    it('should return null for panel not in any zone', () => {
      const layout = createDefaultLayout();
      expect(findPanelZone(layout, 'audio-mixer')).toBeNull();
    });
  });

  describe('revealWorkspacePanel', () => {
    it('should restore and activate a missing panel in the default zone', () => {
      const zoneId = revealWorkspacePanel('terminal', 'bottom');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(zoneId).toBe('bottom');
      expect(layout.zones.bottom.panelIds).toContain('terminal');
      expect(layout.zones.bottom.activePanelId).toBe('terminal');
      expect(layout.zones.bottom.collapsed).toBe(false);
    });

    it('should not reveal the internal agent review panel as a dock tab', () => {
      const zoneId = revealWorkspacePanel('agent-review', 'bottom');

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(zoneId).toBeNull();
      expect(layout.zones.bottom.panelIds).not.toContain('agent-review');
      expect(layout.zones.bottom.activePanelId).toBe('history');
      expect(layout.zones.bottom.collapsed).toBe(true);
    });

    it('should move a panel back to its canonical zone when requested', () => {
      const store = useWorkspaceLayoutStore.getState();
      store.movePanel('explorer', 'right');

      const zoneId = revealWorkspacePanel('explorer', 'left', {
        moveToDefaultZone: true,
      });

      const { layout } = useWorkspaceLayoutStore.getState();
      expect(zoneId).toBe('left');
      expect(layout.zones.left.panelIds).toContain('explorer');
      expect(layout.zones.left.activePanelId).toBe('explorer');
      expect(layout.zones.right.panelIds).not.toContain('explorer');
    });
  });

  // ===========================================================================
  // Workspace Presets (TASK-S37-002)
  // ===========================================================================

  describe('workspace presets', () => {
    describe('built-in presets', () => {
      it('should have 5 built-in presets available', () => {
        expect(WORKSPACE_PRESETS).toHaveLength(5);
        const ids = WORKSPACE_PRESETS.map((p) => p.id);
        expect(ids).toEqual(['editing', 'color', 'audio', 'effects', 'assembly']);
      });

      it('should mark all built-in presets as builtIn', () => {
        for (const preset of WORKSPACE_PRESETS) {
          expect(preset.builtIn).toBe(true);
        }
      });

      it('should include timeline in every built-in preset', () => {
        for (const preset of WORKSPACE_PRESETS) {
          const allPanels = Object.values(preset.layout.zones).flatMap((z) => z.panelIds);
          expect(allPanels).toContain('timeline');
        }
      });
    });

    describe('applyPreset', () => {
      it('should apply the Editing preset layout when selected', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('editing');

        const { layout, activePresetId } = useWorkspaceLayoutStore.getState();
        expect(activePresetId).toBe('editing');
        expect(layout.zones.left.panelIds).toEqual(['explorer']);
        expect(layout.zones['center-top'].activePanelId).toBe('source-monitor');
        expect(layout.sizes.centerSplitRatio).toBe(0.4);
      });

      it('should strip internal review panels from custom preset layouts', () => {
        const staleLayout = createDefaultLayout();
        staleLayout.zones.bottom = {
          panelIds: ['history', 'agent-review', 'transcript'],
          activePanelId: 'agent-review',
          collapsed: false,
        };
        const stalePreset: WorkspacePreset = {
          id: 'custom-agent-review',
          name: 'Stale Agent Review',
          description: '',
          layout: staleLayout,
          builtIn: false,
        };

        useWorkspaceLayoutStore.setState((state) => ({
          ...state,
          customPresets: [stalePreset],
        }));

        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('custom-agent-review');

        const { layout } = useWorkspaceLayoutStore.getState();
        expect(layout.zones.bottom.panelIds).toEqual(['history', 'transcript']);
        expect(layout.zones.bottom.activePanelId).toBe('history');
      });

      it('should apply the Color preset with inspector and comparison in right zone', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('color');

        const { layout, activePresetId } = useWorkspaceLayoutStore.getState();
        expect(activePresetId).toBe('color');
        expect(layout.zones.left.collapsed).toBe(true);
        expect(layout.zones.right.panelIds).toContain('inspector');
        expect(layout.zones.right.panelIds).toContain('comparison');
        expect(layout.zones.right.panelIds).toContain('ai-assistant');
        expect(layout.sizes.rightWidth).toBe(380);
      });

      it('should apply the Audio preset with mixer in left zone', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('audio');

        const { layout, activePresetId } = useWorkspaceLayoutStore.getState();
        expect(activePresetId).toBe('audio');
        expect(layout.zones.left.panelIds).toEqual(['audio-mixer']);
        expect(layout.zones.left.activePanelId).toBe('audio-mixer');
        expect(layout.zones.right.panelIds).toContain('ai-assistant');
      });

      it('should apply the Effects preset with AI assistant in right zone', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('effects');

        const { layout, activePresetId } = useWorkspaceLayoutStore.getState();
        expect(activePresetId).toBe('effects');
        expect(layout.zones.right.panelIds).toContain('ai-assistant');
        expect(layout.sizes.rightWidth).toBe(340);
      });

      it('should apply the Assembly preset with collapsed right zone', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('assembly');

        const { layout, activePresetId } = useWorkspaceLayoutStore.getState();
        expect(activePresetId).toBe('assembly');
        expect(layout.zones.right.collapsed).toBe(true);
        expect(layout.zones.right.panelIds).toEqual(['ai-assistant']);
        expect(layout.sizes.centerSplitRatio).toBe(0.65);
      });

      it('should not change layout when applying non-existent preset', () => {
        const store = useWorkspaceLayoutStore.getState();
        const before = JSON.stringify(store.layout);

        store.applyPreset('non-existent');

        const after = useWorkspaceLayoutStore.getState();
        expect(JSON.stringify(after.layout)).toBe(before);
        expect(after.activePresetId).toBeNull();
      });

      it('should create independent layout copy (not shared reference)', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('editing');

        // Modify the applied layout
        store.movePanel('explorer', 'right');

        // Original preset should be unchanged
        const preset = WORKSPACE_PRESETS.find((p) => p.id === 'editing')!;
        expect(preset.layout.zones.left.panelIds).toEqual(['explorer']);
      });
    });

    describe('activePresetId tracking', () => {
      it('should clear activePresetId when panel is moved', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('editing');
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBe('editing');

        store.movePanel('explorer', 'right');
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBeNull();
      });

      it('should clear activePresetId on resetLayout', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('color');
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBe('color');

        store.resetLayout();
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBeNull();
      });

      it('should not clear activePresetId when switching active tab', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('editing');

        store.setActivePanel('right', 'ai-assistant');
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBe('editing');
      });

      it('should clear activePresetId when resizing zones', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('editing');
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBe('editing');

        store.setLeftWidth(400);
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBeNull();
      });

      it('should clear activePresetId when toggling zone collapse', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('editing');
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBe('editing');

        store.toggleZoneCollapse('left');
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBeNull();
      });
    });

    describe('clearTransientState', () => {
      it('should clear drag state without resetting layout', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('color');
        store.setLeftWidth(400);
        store.startDrag('explorer');

        expect(useWorkspaceLayoutStore.getState().isDragging).toBe(true);
        expect(useWorkspaceLayoutStore.getState().layout.sizes.leftWidth).toBe(400);

        store.clearTransientState();

        expect(useWorkspaceLayoutStore.getState().isDragging).toBe(false);
        expect(useWorkspaceLayoutStore.getState().draggedPanelId).toBeNull();
        // Layout should be preserved
        expect(useWorkspaceLayoutStore.getState().layout.sizes.leftWidth).toBe(400);
      });
    });

    describe('saveCustomPreset', () => {
      it('should save current layout as a custom preset', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.movePanel('explorer', 'right');
        store.setLeftWidth(400);

        const id = store.saveCustomPreset('My Layout', 'My custom workspace');
        const { customPresets, activePresetId } = useWorkspaceLayoutStore.getState();

        expect(customPresets).toHaveLength(1);
        expect(customPresets[0].id).toBe(id);
        expect(customPresets[0].name).toBe('My Layout');
        expect(customPresets[0].description).toBe('My custom workspace');
        expect(customPresets[0].builtIn).toBe(false);
        expect(activePresetId).toBe(id);
      });

      it('should save layout snapshot (not a live reference)', () => {
        const store = useWorkspaceLayoutStore.getState();
        const presetId = store.saveCustomPreset('Snapshot Test');

        // Modify layout after saving
        store.movePanel('explorer', 'bottom');

        const { customPresets } = useWorkspaceLayoutStore.getState();
        const saved = customPresets.find((p) => p.id === presetId)!;
        // Saved preset should still have explorer in left zone
        expect(saved.layout.zones.left.panelIds).toContain('explorer');
      });

      it('should allow saving multiple custom presets', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.saveCustomPreset('Layout A');
        store.saveCustomPreset('Layout B');
        store.saveCustomPreset('Layout C');

        const { customPresets } = useWorkspaceLayoutStore.getState();
        expect(customPresets).toHaveLength(3);
        expect(customPresets.map((p) => p.name)).toEqual(['Layout A', 'Layout B', 'Layout C']);
      });

      it('should use empty description when not provided', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.saveCustomPreset('No Description');

        const { customPresets } = useWorkspaceLayoutStore.getState();
        expect(customPresets[0].description).toBe('');
      });
    });

    describe('load custom preset', () => {
      it('should load a previously saved custom preset', () => {
        const store = useWorkspaceLayoutStore.getState();

        // Create a custom layout and save it
        store.movePanel('explorer', 'right');
        store.setLeftWidth(400);
        const presetId = store.saveCustomPreset('Custom Layout');

        // Reset to default
        store.resetLayout();
        expect(useWorkspaceLayoutStore.getState().layout.zones.left.panelIds).toContain('explorer');

        // Apply the saved custom preset
        store.applyPreset(presetId);

        const { layout, activePresetId } = useWorkspaceLayoutStore.getState();
        expect(activePresetId).toBe(presetId);
        expect(layout.zones.right.panelIds).toContain('explorer');
        expect(layout.zones.left.panelIds).not.toContain('explorer');
      });
    });

    describe('deleteCustomPreset', () => {
      it('should delete a custom preset', () => {
        const store = useWorkspaceLayoutStore.getState();
        const presetId = store.saveCustomPreset('To Delete');
        expect(useWorkspaceLayoutStore.getState().customPresets).toHaveLength(1);

        const result = store.deleteCustomPreset(presetId);
        expect(result).toBe(true);
        expect(useWorkspaceLayoutStore.getState().customPresets).toHaveLength(0);
      });

      it('should clear activePresetId when deleting the active preset', () => {
        const store = useWorkspaceLayoutStore.getState();
        const presetId = store.saveCustomPreset('Active Custom');
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBe(presetId);

        store.deleteCustomPreset(presetId);
        expect(useWorkspaceLayoutStore.getState().activePresetId).toBeNull();
      });

      it('should not delete built-in presets', () => {
        const store = useWorkspaceLayoutStore.getState();
        const result = store.deleteCustomPreset('editing');
        expect(result).toBe(false);
        expect(WORKSPACE_PRESETS.find((p) => p.id === 'editing')).toBeDefined();
      });

      it('should return false for non-existent preset', () => {
        const store = useWorkspaceLayoutStore.getState();
        const result = store.deleteCustomPreset('non-existent');
        expect(result).toBe(false);
      });

      it('should not affect other custom presets when deleting one', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.saveCustomPreset('Keep Me');
        const deleteId = store.saveCustomPreset('Delete Me');
        store.saveCustomPreset('Keep Me Too');

        store.deleteCustomPreset(deleteId);

        const { customPresets } = useWorkspaceLayoutStore.getState();
        expect(customPresets).toHaveLength(2);
        expect(customPresets.map((p) => p.name)).toEqual(['Keep Me', 'Keep Me Too']);
      });
    });

    describe('renameCustomPreset', () => {
      it('should rename a custom preset', () => {
        const store = useWorkspaceLayoutStore.getState();
        const presetId = store.saveCustomPreset('Old Name');

        const result = store.renameCustomPreset(presetId, 'New Name');
        expect(result).toBe(true);

        const { customPresets } = useWorkspaceLayoutStore.getState();
        expect(customPresets[0].name).toBe('New Name');
      });

      it('should return false for non-existent preset', () => {
        const store = useWorkspaceLayoutStore.getState();
        const result = store.renameCustomPreset('non-existent', 'Whatever');
        expect(result).toBe(false);
      });
    });

    describe('findPreset', () => {
      it('should find built-in presets by ID', () => {
        const preset = findPreset('editing', []);
        expect(preset).toBeDefined();
        expect(preset!.name).toBe('Editing');
        expect(preset!.builtIn).toBe(true);
      });

      it('should find custom presets by ID', () => {
        const custom = {
          id: 'custom-1',
          name: 'My Custom',
          description: '',
          layout: createDefaultLayout(),
          builtIn: false,
        };
        const preset = findPreset('custom-1', [custom]);
        expect(preset).toBeDefined();
        expect(preset!.name).toBe('My Custom');
      });

      it('should return undefined for non-existent preset', () => {
        expect(findPreset('nope', [])).toBeUndefined();
      });

      it('should prioritize built-in over custom with same ID', () => {
        const custom = {
          id: 'editing',
          name: 'My Editing Override',
          description: '',
          layout: createDefaultLayout(),
          builtIn: false,
        };
        const preset = findPreset('editing', [custom]);
        expect(preset!.name).toBe('Editing');
        expect(preset!.builtIn).toBe(true);
      });
    });

    describe('persistence', () => {
      it('should include customPresets and activePresetId in persisted state', () => {
        const store = useWorkspaceLayoutStore.getState();
        store.applyPreset('editing');
        store.saveCustomPreset('Persisted Layout');

        // Verify the state includes these fields
        const { activePresetId, customPresets } = useWorkspaceLayoutStore.getState();
        expect(activePresetId).not.toBeNull();
        expect(customPresets).toHaveLength(1);
      });

      it('should strip non-persisted panels before saving state', () => {
        const staleLayout = createDefaultLayout();
        staleLayout.zones.bottom = {
          panelIds: ['history', 'terminal', 'agent-review', 'transcript'],
          activePanelId: 'terminal',
          collapsed: false,
        };
        const stalePreset: WorkspacePreset = {
          id: 'custom-transient-panels',
          name: 'Transient Panels',
          description: '',
          layout: staleLayout,
          builtIn: false,
        };
        const partialize = useWorkspaceLayoutStore.persist.getOptions().partialize as (state: {
          layout: WorkspaceLayout;
          activePresetId?: string | null;
          customPresets?: WorkspacePreset[];
        }) => {
          layout: WorkspaceLayout;
          activePresetId: string | null;
          customPresets: WorkspacePreset[];
        };

        const persisted = partialize({
          layout: staleLayout,
          activePresetId: undefined,
          customPresets: [stalePreset],
        });

        expect(persisted.activePresetId).toBeNull();
        expect(persisted.layout.zones.bottom.panelIds).toEqual(['history', 'transcript']);
        expect(persisted.layout.zones.bottom.activePanelId).toBe('history');
        expect(persisted.customPresets[0].layout.zones.bottom.panelIds).toEqual([
          'history',
          'transcript',
        ]);
      });

      it('should migrate persisted layouts without internal review dock tabs', async () => {
        const staleLayout = createDefaultLayout();
        staleLayout.zones.bottom = {
          panelIds: ['history', 'agent-review', 'transcript'],
          activePanelId: 'agent-review',
          collapsed: false,
        };
        const stalePreset: WorkspacePreset = {
          id: 'custom-agent-review',
          name: 'Stale Agent Review',
          description: '',
          layout: staleLayout,
          builtIn: false,
        };
        const migrate = useWorkspaceLayoutStore.persist.getOptions().migrate;

        expect(useWorkspaceLayoutStore.persist.getOptions().version).toBe(3);
        expect(migrate).toBeDefined();

        const migrated = (await migrate?.(
          {
            layout: staleLayout,
            activePresetId: 'custom-agent-review',
            customPresets: [stalePreset],
          },
          2,
        )) as {
          layout: WorkspaceLayout;
          customPresets: WorkspacePreset[];
        };

        expect(migrated.layout.zones.bottom.panelIds).toEqual(['history', 'transcript']);
        expect(migrated.layout.zones.bottom.activePanelId).toBe('history');
        expect(migrated.customPresets[0].layout.zones.bottom.panelIds).toEqual([
          'history',
          'transcript',
        ]);
      });
    });
  });
});

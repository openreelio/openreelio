import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  findPanelZone,
  useWorkspaceLayoutStore,
  type DockZoneId,
  type PanelId,
} from '@/stores/workspaceLayoutStore';
import { useResponsiveSidebarState } from './useResponsiveSidebarState';

interface UseDockableAIPanelOptions {
  autoCollapseBreakpoint: number;
  initialWidth?: number;
}

interface DockableAIPanelState {
  isOpen: boolean;
  width: number;
  setWidth: (width: number) => void;
  toggle: () => void;
}

const AI_PANEL_ID: PanelId = 'ai-assistant';
const DEFAULT_AI_ZONE: DockZoneId = 'right';
const ZONE_IDS: DockZoneId[] = ['left', 'center-top', 'center-bottom', 'right', 'bottom'];

function getFallbackPanel(
  panelIds: PanelId[],
  previousPanelId: PanelId | null,
): PanelId | null {
  if (previousPanelId && previousPanelId !== AI_PANEL_ID && panelIds.includes(previousPanelId)) {
    return previousPanelId;
  }

  return panelIds.find((panelId) => panelId !== AI_PANEL_ID) ?? null;
}

export function useDockableAIPanel({
  autoCollapseBreakpoint,
  initialWidth = 320,
}: UseDockableAIPanelOptions): DockableAIPanelState {
  const { width, setWidth } = useResponsiveSidebarState({
    autoCollapseBreakpoint,
    initialWidth,
  });
  const layout = useWorkspaceLayoutStore((state) => state.layout);
  const setActivePanel = useWorkspaceLayoutStore((state) => state.setActivePanel);
  const setZoneCollapsed = useWorkspaceLayoutStore((state) => state.setZoneCollapsed);
  const restorePanel = useWorkspaceLayoutStore((state) => state.restorePanel);

  const aiZoneId = useMemo(
    () => findPanelZone(layout, AI_PANEL_ID) ?? DEFAULT_AI_ZONE,
    [layout],
  );
  const aiZone = layout.zones[aiZoneId];
  const isOpen = aiZone.activePanelId === AI_PANEL_ID && !aiZone.collapsed;
  const lastNonAiPanelByZoneRef = useRef<Record<DockZoneId, PanelId | null>>({
    left: layout.zones.left.activePanelId,
    'center-top': layout.zones['center-top'].activePanelId,
    'center-bottom': layout.zones['center-bottom'].activePanelId,
    right: layout.zones.right.activePanelId,
    bottom: layout.zones.bottom.activePanelId,
  });

  useEffect(() => {
    for (const zoneId of ZONE_IDS) {
      const activePanelId = layout.zones[zoneId].activePanelId;
      if (activePanelId && activePanelId !== AI_PANEL_ID) {
        lastNonAiPanelByZoneRef.current[zoneId] = activePanelId;
      }
    }
  }, [layout]);

  const openAiPanel = useCallback(() => {
    let targetZoneId = findPanelZone(useWorkspaceLayoutStore.getState().layout, AI_PANEL_ID);
    if (!targetZoneId) {
      restorePanel(AI_PANEL_ID, DEFAULT_AI_ZONE);
      targetZoneId = findPanelZone(useWorkspaceLayoutStore.getState().layout, AI_PANEL_ID)
        ?? DEFAULT_AI_ZONE;
    }

    setActivePanel(targetZoneId, AI_PANEL_ID);
    setZoneCollapsed(targetZoneId, false);
  }, [restorePanel, setActivePanel, setZoneCollapsed]);

  const closeAiPanel = useCallback(() => {
    const currentLayout = useWorkspaceLayoutStore.getState().layout;
    const currentZoneId = findPanelZone(currentLayout, AI_PANEL_ID) ?? DEFAULT_AI_ZONE;
    const currentZone = currentLayout.zones[currentZoneId];
    const fallbackPanelId = getFallbackPanel(
      currentZone.panelIds,
      lastNonAiPanelByZoneRef.current[currentZoneId],
    );

    if (fallbackPanelId) {
      setActivePanel(currentZoneId, fallbackPanelId);
      setZoneCollapsed(currentZoneId, false);
      return;
    }

    setZoneCollapsed(currentZoneId, true);
  }, [setActivePanel, setZoneCollapsed]);

  const toggle = useCallback(() => {
    if (isOpen) {
      closeAiPanel();
      return;
    }

    openAiPanel();
  }, [closeAiPanel, isOpen, openAiPanel]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;

      if ((event.ctrlKey || event.metaKey) && event.key === '/') {
        event.preventDefault();
        toggle();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [toggle]);

  useEffect(() => {
    let previousWidth = window.innerWidth;

    const handleResize = () => {
      const currentWidth = window.innerWidth;
      const crossedBelowBreakpoint =
        previousWidth >= autoCollapseBreakpoint && currentWidth < autoCollapseBreakpoint;
      previousWidth = currentWidth;

      const currentLayout = useWorkspaceLayoutStore.getState().layout;
      const currentZoneId = findPanelZone(currentLayout, AI_PANEL_ID) ?? DEFAULT_AI_ZONE;
      const currentZone = currentLayout.zones[currentZoneId];
      const isCurrentlyOpen =
        currentZone.activePanelId === AI_PANEL_ID && !currentZone.collapsed;

      if (crossedBelowBreakpoint && isCurrentlyOpen) {
        closeAiPanel();
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [autoCollapseBreakpoint, closeAiPanel]);

  return {
    isOpen,
    width,
    setWidth,
    toggle,
  };
}

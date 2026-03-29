/**
 * DockableEditorLayout Component
 *
 * A workspace-aware layout that replaces MainLayout for the editor view.
 * Reads dock zone configuration from workspaceLayoutStore and renders
 * panels in their assigned zones with resize handles and drag-drop support.
 */

import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import {
  MIN_ZONE_SIZES,
  useWorkspaceLayoutStore,
  type PanelId,
  type DockZoneId,
} from '@/stores/workspaceLayoutStore';
import { DockZone } from './DockZone';
import { ResizeHandle } from './ResizeHandle';

// =============================================================================
// Types
// =============================================================================

export interface DockableEditorLayoutProps {
  /** Header element (fixed, not dockable) */
  header: ReactNode;
  /** Map of panel ID → panel content */
  panelContent: Partial<Record<PanelId, ReactNode>>;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Collapsed sidebar width in pixels */
const COLLAPSED_WIDTH = 40;
/** Collapsed bottom panel height in pixels */
const COLLAPSED_BOTTOM_HEIGHT = 32;

// =============================================================================
// Component
// =============================================================================

export function DockableEditorLayout({
  header,
  panelContent,
  className = '',
}: DockableEditorLayoutProps): JSX.Element {
  const layout = useWorkspaceLayoutStore((s) => s.layout);
  const isDragging = useWorkspaceLayoutStore((s) => s.isDragging);
  const draggedPanelId = useWorkspaceLayoutStore((s) => s.draggedPanelId);
  const movePanel = useWorkspaceLayoutStore((s) => s.movePanel);
  const setActivePanel = useWorkspaceLayoutStore((s) => s.setActivePanel);
  const toggleZoneCollapse = useWorkspaceLayoutStore((s) => s.toggleZoneCollapse);
  const setZoneCollapsed = useWorkspaceLayoutStore((s) => s.setZoneCollapsed);
  const setLeftWidth = useWorkspaceLayoutStore((s) => s.setLeftWidth);
  const setRightWidth = useWorkspaceLayoutStore((s) => s.setRightWidth);
  const setCenterSplitRatio = useWorkspaceLayoutStore((s) => s.setCenterSplitRatio);
  const setBottomHeight = useWorkspaceLayoutStore((s) => s.setBottomHeight);
  const startDrag = useWorkspaceLayoutStore((s) => s.startDrag);
  const endDrag = useWorkspaceLayoutStore((s) => s.endDrag);

  const centerRef = useRef<HTMLElement>(null);
  const { zones, sizes } = layout;

  // Filter zone panelIds to only those with renderable content (e.g. feature-flagged panels)
  const availablePanelIds = useMemo(() => {
    const available = new Set<PanelId>();
    for (const [id, content] of Object.entries(panelContent)) {
      if (content != null) available.add(id as PanelId);
    }
    return available;
  }, [panelContent]);

  const filterZonePanels = useCallback(
    (panelIds: PanelId[]) => panelIds.filter((id) => availablePanelIds.has(id)),
    [availablePanelIds],
  );

  // Panel renderer — looks up content from the registry
  const renderPanel = useCallback(
    (panelId: PanelId): ReactNode => panelContent[panelId] ?? null,
    [panelContent],
  );

  // Resize handlers — read current size from store to avoid stale closures
  // during fast drag (multiple pointermove events between renders)
  const handleLeftResize = useCallback(
    (delta: number) => {
      const current = useWorkspaceLayoutStore.getState().layout.sizes.leftWidth;
      setLeftWidth(current + delta);
    },
    [setLeftWidth],
  );

  const handleRightResize = useCallback(
    (delta: number) => {
      const current = useWorkspaceLayoutStore.getState().layout.sizes.rightWidth;
      setRightWidth(current - delta);
    },
    [setRightWidth],
  );

  const handleCenterSplitResize = useCallback(
    (delta: number) => {
      if (!centerRef.current) return;
      const centerHeight = centerRef.current.clientHeight;
      if (centerHeight <= 0) return;
      const ratioChange = delta / centerHeight;
      const current = useWorkspaceLayoutStore.getState().layout.sizes.centerSplitRatio;
      setCenterSplitRatio(current + ratioChange);
    },
    [setCenterSplitRatio],
  );

  const handleBottomResize = useCallback(
    (delta: number) => {
      const current = useWorkspaceLayoutStore.getState().layout.sizes.bottomHeight;
      setBottomHeight(current - delta);
    },
    [setBottomHeight],
  );

  // Tab click handlers — clicking active tab collapses, clicking inactive expands
  const makeTabClickHandler = useCallback(
    (zoneId: DockZoneId) => (panelId: PanelId) => {
      const zone = zones[zoneId];
      if (zone.activePanelId === panelId && !zone.collapsed) {
        toggleZoneCollapse(zoneId);
      } else {
        setActivePanel(zoneId, panelId);
        if (zone.collapsed) {
          setZoneCollapsed(zoneId, false);
        }
      }
    },
    [zones, setActivePanel, toggleZoneCollapse, setZoneCollapsed],
  );

  // Drop handler factory
  const makeDropHandler = useCallback(
    (zoneId: DockZoneId) => (panelId: PanelId) => {
      movePanel(panelId, zoneId);
    },
    [movePanel],
  );

  // Shared zone props
  const sharedZoneProps = {
    isDragging,
    draggedPanelId,
    onDragStart: startDrag,
    onDragEnd: endDrag,
    renderPanel,
  };

  // Filter zone panelIds — hide tabs for panels without renderable content
  const filteredLeft = filterZonePanels(zones.left.panelIds);
  const filteredCenterTop = filterZonePanels(zones['center-top'].panelIds);
  const filteredCenterBottom = filterZonePanels(zones['center-bottom'].panelIds);
  const filteredRight = filterZonePanels(zones.right.panelIds);
  const filteredBottom = filterZonePanels(zones.bottom.panelIds);

  // Compute actual widths/heights
  const leftWidth = zones.left.collapsed ? COLLAPSED_WIDTH : sizes.leftWidth;
  const rightWidth = zones.right.collapsed ? COLLAPSED_WIDTH : sizes.rightWidth;
  const bottomHeight = zones.bottom.collapsed ? COLLAPSED_BOTTOM_HEIGHT : sizes.bottomHeight;

  const leftHasPanels = filteredLeft.length > 0;
  const rightHasPanels = filteredRight.length > 0;
  const bottomHasPanels = filteredBottom.length > 0;
  const showLeftZone = leftHasPanels || isDragging;
  const showRightZone = rightHasPanels || isDragging;
  const showBottomZone = bottomHasPanels || isDragging;
  const leftZoneWidth = leftHasPanels ? leftWidth : MIN_ZONE_SIZES.sidebarWidth;
  const rightZoneWidth = rightHasPanels ? rightWidth : MIN_ZONE_SIZES.sidebarWidth;
  const bottomZoneHeight = bottomHasPanels ? bottomHeight : MIN_ZONE_SIZES.bottomHeight;

  return (
    <div
      className={`flex h-screen min-h-screen flex-col overflow-hidden bg-editor-bg text-editor-text ${className}`}
    >
      {/* Header (fixed) */}
      <header role="banner" className="shrink-0">
        {header}
      </header>

      {/* Main content area */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left sidebar zone */}
        {showLeftZone && (
          <>
            <div style={{ width: `${leftZoneWidth}px` }} className="shrink-0">
              <DockZone
                zoneId="left"
                panelIds={filteredLeft}
                activePanelId={filteredLeft.includes(zones.left.activePanelId!) ? zones.left.activePanelId : filteredLeft[0] ?? null}
                collapsed={zones.left.collapsed}
                onTabClick={makeTabClickHandler('left')}
                onToggleCollapse={() => toggleZoneCollapse('left')}
                onDrop={makeDropHandler('left')}
                collapseDirection="horizontal"
                className="h-full border-r border-editor-border"
                {...sharedZoneProps}
              />
            </div>
            {leftHasPanels && !zones.left.collapsed && (
              <ResizeHandle orientation="horizontal" onResize={handleLeftResize} />
            )}
          </>
        )}

        {/* Center area (top + bottom split) */}
        <main
          ref={centerRef}
          role="main"
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
        >
          {/* Center top zone (monitors) */}
          <div style={{ flex: `${sizes.centerSplitRatio}` }} className="min-h-0 overflow-hidden">
            <DockZone
              zoneId="center-top"
              panelIds={filteredCenterTop}
              activePanelId={filteredCenterTop.includes(zones['center-top'].activePanelId!) ? zones['center-top'].activePanelId : filteredCenterTop[0] ?? null}
              collapsed={zones['center-top'].collapsed}
              onTabClick={makeTabClickHandler('center-top')}
              onToggleCollapse={() => toggleZoneCollapse('center-top')}
              onDrop={makeDropHandler('center-top')}
              className="h-full"
              {...sharedZoneProps}
            />
          </div>

          {/* Center split resize handle */}
          <ResizeHandle orientation="vertical" onResize={handleCenterSplitResize} />

          {/* Center bottom zone (timeline) */}
          <div
            style={{ flex: `${1 - sizes.centerSplitRatio}` }}
            className="min-h-0 overflow-hidden"
          >
            <DockZone
              zoneId="center-bottom"
              panelIds={filteredCenterBottom}
              activePanelId={filteredCenterBottom.includes(zones['center-bottom'].activePanelId!) ? zones['center-bottom'].activePanelId : filteredCenterBottom[0] ?? null}
              collapsed={zones['center-bottom'].collapsed}
              onTabClick={makeTabClickHandler('center-bottom')}
              onToggleCollapse={() => toggleZoneCollapse('center-bottom')}
              onDrop={makeDropHandler('center-bottom')}
              className="h-full"
              {...sharedZoneProps}
            />
          </div>
        </main>

        {/* Right sidebar zone */}
        {showRightZone && (
          <>
            {rightHasPanels && !zones.right.collapsed && (
              <ResizeHandle orientation="horizontal" onResize={handleRightResize} />
            )}
            <div style={{ width: `${rightZoneWidth}px` }} className="shrink-0">
              <DockZone
                zoneId="right"
                panelIds={filteredRight}
                activePanelId={filteredRight.includes(zones.right.activePanelId!) ? zones.right.activePanelId : filteredRight[0] ?? null}
                collapsed={zones.right.collapsed}
                onTabClick={makeTabClickHandler('right')}
                onToggleCollapse={() => toggleZoneCollapse('right')}
                onDrop={makeDropHandler('right')}
                collapseDirection="horizontal"
                className="h-full border-l border-editor-border"
                {...sharedZoneProps}
              />
            </div>
          </>
        )}
      </div>

      {/* Bottom zone */}
      {showBottomZone && (
        <>
          {bottomHasPanels && <ResizeHandle orientation="vertical" onResize={handleBottomResize} />}
          <footer
            role="contentinfo"
            className="shrink-0"
            style={{ height: `${bottomZoneHeight}px` }}
          >
            <DockZone
              zoneId="bottom"
              panelIds={filteredBottom}
              activePanelId={filteredBottom.includes(zones.bottom.activePanelId!) ? zones.bottom.activePanelId : filteredBottom[0] ?? null}
              collapsed={zones.bottom.collapsed}
              onTabClick={makeTabClickHandler('bottom')}
              onToggleCollapse={() => toggleZoneCollapse('bottom')}
              onDrop={makeDropHandler('bottom')}
              className="h-full border-t border-editor-border"
              {...sharedZoneProps}
            />
          </footer>
        </>
      )}
    </div>
  );
}

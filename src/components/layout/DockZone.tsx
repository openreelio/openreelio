/**
 * DockZone Component
 *
 * A dock zone that renders panels as tabs. Supports:
 * - Tab bar with panel switching
 * - Drag-from-tab to move panels between zones
 * - Drop target for receiving panels
 * - Collapse/expand toggle
 */

import { useCallback, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import { PANEL_REGISTRY, type DockZoneId, type PanelId } from '@/stores/workspaceLayoutStore';

// =============================================================================
// Types
// =============================================================================

export interface DockZoneProps {
  /** Zone identifier */
  zoneId: DockZoneId;
  /** Ordered list of panel IDs in this zone */
  panelIds: PanelId[];
  /** Currently active panel */
  activePanelId: PanelId | null;
  /** Whether the zone is collapsed */
  collapsed: boolean;
  /** Render function for panel content */
  renderPanel: (panelId: PanelId) => ReactNode;
  /** Called when a tab is clicked */
  onTabClick: (panelId: PanelId) => void;
  /** Called when the collapse toggle is clicked */
  onToggleCollapse: () => void;
  /** Called when a panel drag starts from this zone */
  onDragStart: (panelId: PanelId) => void;
  /** Called when a panel is dropped into this zone */
  onDrop: (panelId: PanelId) => void;
  /** Called when drag ends */
  onDragEnd: () => void;
  /** Whether a panel is currently being dragged globally */
  isDragging: boolean;
  /** The panel currently being dragged */
  draggedPanelId: PanelId | null;
  /** Whether to show tab bar (hide for single-panel zones) */
  showTabs?: boolean;
  /** Collapse direction for icon */
  collapseDirection?: 'horizontal' | 'vertical';
  /** Additional CSS classes for the container */
  className?: string;
  /** Optional actions rendered on the right side of the tab bar */
  headerActions?: ReactNode;
}

// =============================================================================
// Component
// =============================================================================

export function DockZone({
  zoneId,
  panelIds,
  activePanelId,
  collapsed,
  renderPanel,
  onTabClick,
  onToggleCollapse,
  onDragStart,
  onDrop,
  onDragEnd,
  isDragging,
  draggedPanelId,
  showTabs = true,
  collapseDirection = 'vertical',
  className = '',
  headerActions = null,
}: DockZoneProps): JSX.Element {
  const [isDropTarget, setIsDropTarget] = useState(false);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isDragging || !draggedPanelId) return;
      // Only accept if the dragged panel is not already in this zone
      if (panelIds.includes(draggedPanelId)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setIsDropTarget(true);
    },
    [isDragging, draggedPanelId, panelIds],
  );

  const handleDragLeave = useCallback(() => {
    setIsDropTarget(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDropTarget(false);
      const panelId = e.dataTransfer.getData('text/panel-id') as PanelId;
      if (panelId) {
        onDrop(panelId);
      }
    },
    [onDrop],
  );

  const handleTabDragStart = useCallback(
    (e: React.DragEvent, panelId: PanelId) => {
      e.dataTransfer.setData('text/panel-id', panelId);
      e.dataTransfer.effectAllowed = 'move';
      onDragStart(panelId);
    },
    [onDragStart],
  );

  const handleTabDragEnd = useCallback(() => {
    onDragEnd();
  }, [onDragEnd]);

  if (panelIds.length === 0) {
    // Empty zone — only show as drop target when dragging
    if (!isDragging) return <></>;
    return (
      <div
        data-testid={`dock-zone-${zoneId}-empty`}
        className={`flex items-center justify-center border-2 border-dashed ${
          isDropTarget ? 'border-primary-500 bg-primary-500/10' : 'border-editor-border/50'
        } rounded transition-colors ${className}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className="text-xs text-editor-text-muted">Drop panel here</span>
      </div>
    );
  }

  // Icon direction depends on zone position: left sidebar collapses left,
  // right sidebar collapses right, vertical zones collapse up/down.
  const CollapseIcon =
    collapseDirection === 'horizontal'
      ? zoneId === 'right'
        ? collapsed
          ? ChevronLeft
          : ChevronRight
        : collapsed
          ? ChevronRight
          : ChevronLeft
      : collapsed
        ? ChevronUp
        : ChevronDown;

  const dropHighlight = isDropTarget ? 'ring-2 ring-primary-500 ring-inset' : '';

  return (
    <div
      data-testid={`dock-zone-${zoneId}`}
      className={`flex flex-col overflow-hidden bg-editor-sidebar ${dropHighlight} transition-shadow ${className}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Tab bar */}
      {showTabs && (
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-editor-border px-1">
          <div
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto"
            role="tablist"
            aria-label={`${zoneId} panels`}
          >
            {panelIds.map((panelId) => {
              const meta = PANEL_REGISTRY[panelId];
              const isActive = activePanelId === panelId && !collapsed;
              const isDraggable = panelId !== 'terminal';
              return (
                <button
                  key={panelId}
                  draggable={isDraggable}
                  onDragStart={isDraggable ? (e) => handleTabDragStart(e, panelId) : undefined}
                  onDragEnd={handleTabDragEnd}
                  onClick={() => onTabClick(panelId)}
                  className={`flex shrink-0 items-center gap-1 rounded-t px-2 py-1 text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-editor-bg text-editor-text'
                      : 'text-editor-text-muted hover:text-editor-text hover:bg-editor-border/50'
                  }`}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`dock-panel-${panelId}`}
                  title={isDraggable ? `${meta.label} (drag to move)` : meta.label}
                >
                  {isDraggable && <GripVertical className="w-3 h-3 opacity-40" />}
                  <span className="whitespace-nowrap">{meta.label}</span>
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerActions}
            <button
              onClick={onToggleCollapse}
              className="shrink-0 rounded p-1 text-editor-text-muted transition-colors hover:bg-editor-border hover:text-editor-text"
              aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
            >
              <CollapseIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Panel content */}
      {!collapsed && activePanelId && (
        <div
          id={`dock-panel-${activePanelId}`}
          role="tabpanel"
          className="min-h-0 flex-1 overflow-hidden bg-editor-bg"
        >
          {renderPanel(activePanelId)}
        </div>
      )}
    </div>
  );
}

/**
 * DockZone Component
 *
 * A dock zone that renders panels as tabs. Supports:
 * - Tab bar with panel switching
 * - Drag-from-tab to move panels between zones
 * - Drop target for receiving panels
 * - Collapse/expand toggle
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  FileText,
  Film,
  FolderOpen,
  GitCompareArrows,
  GripVertical,
  History,
  Monitor,
  Play,
  Sliders,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
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
  /** Panels that should stay mounted while this zone is collapsed */
  keepMountedPanelIds?: readonly PanelId[];
}

// =============================================================================
// Component
// =============================================================================

const PANEL_ICONS: Record<PanelId, LucideIcon> = {
  explorer: FolderOpen,
  'source-monitor': Monitor,
  'program-monitor': Play,
  timeline: Film,
  terminal: Terminal,
  inspector: SlidersHorizontal,
  'ai-assistant': Sparkles,
  'agent-review': ClipboardList,
  'audio-mixer': Sliders,
  history: History,
  transcript: FileText,
  performance: Activity,
  comparison: GitCompareArrows,
  generation: Sparkles,
};

const DOCK_PANEL_DRAG_MOVE_EVENT = 'openreelio:dock-panel-drag-move';
const DOCK_PANEL_DRAG_END_EVENT = 'openreelio:dock-panel-drag-end';
const DOCK_PANEL_DRAG_CANCEL_EVENT = 'openreelio:dock-panel-drag-cancel';
const DOCK_PANEL_DRAG_THRESHOLD_PX = 4;

interface DockPanelDragDetail {
  panelId: PanelId;
  clientX: number;
  clientY: number;
}

function emitDockPanelDragEvent(type: string, detail: DockPanelDragDetail): void {
  document.dispatchEvent(new CustomEvent<DockPanelDragDetail>(type, { detail }));
}

function isDockPanelDragEvent(event: Event): event is CustomEvent<DockPanelDragDetail> {
  return (
    event instanceof CustomEvent &&
    event.detail != null &&
    typeof event.detail.panelId === 'string' &&
    typeof event.detail.clientX === 'number' &&
    typeof event.detail.clientY === 'number'
  );
}

function isPointInsideElement(element: HTMLElement, clientX: number, clientY: number): boolean {
  const rect = element.getBoundingClientRect();
  return (
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  );
}

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
  keepMountedPanelIds = [],
}: DockZoneProps): JSX.Element {
  const [isDropTarget, setIsDropTarget] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingPanelDragRef = useRef<{
    panelId: PanelId;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    isDragging: boolean;
  } | null>(null);

  useEffect(() => {
    const handlePanelDragMove = (event: Event) => {
      if (!isDockPanelDragEvent(event)) {
        return;
      }

      const { panelId, clientX, clientY } = event.detail;
      const root = rootRef.current;
      if (!root || panelIds.includes(panelId)) {
        setIsDropTarget(false);
        return;
      }

      setIsDropTarget(isPointInsideElement(root, clientX, clientY));
    };

    const handlePanelDragEnd = (event: Event) => {
      if (!isDockPanelDragEvent(event)) {
        return;
      }

      const { panelId, clientX, clientY } = event.detail;
      const root = rootRef.current;
      const shouldDrop =
        root != null && !panelIds.includes(panelId) && isPointInsideElement(root, clientX, clientY);

      setIsDropTarget(false);
      if (shouldDrop) {
        onDrop(panelId);
      }
    };

    const handlePanelDragCancel = () => {
      setIsDropTarget(false);
    };

    document.addEventListener(DOCK_PANEL_DRAG_MOVE_EVENT, handlePanelDragMove);
    document.addEventListener(DOCK_PANEL_DRAG_END_EVENT, handlePanelDragEnd);
    document.addEventListener(DOCK_PANEL_DRAG_CANCEL_EVENT, handlePanelDragCancel);

    return () => {
      document.removeEventListener(DOCK_PANEL_DRAG_MOVE_EVENT, handlePanelDragMove);
      document.removeEventListener(DOCK_PANEL_DRAG_END_EVENT, handlePanelDragEnd);
      document.removeEventListener(DOCK_PANEL_DRAG_CANCEL_EVENT, handlePanelDragCancel);
    };
  }, [onDrop, panelIds]);

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

  const handleTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, panelId: PanelId) => {
      if (event.button !== 0) {
        return;
      }

      pendingPanelDragRef.current = {
        panelId,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        isDragging: false,
      };

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const currentDrag = pendingPanelDragRef.current;
        if (!currentDrag || currentDrag.pointerId !== pointerEvent.pointerId) {
          return;
        }

        const deltaX = pointerEvent.clientX - currentDrag.startClientX;
        const deltaY = pointerEvent.clientY - currentDrag.startClientY;
        if (!currentDrag.isDragging && Math.hypot(deltaX, deltaY) < DOCK_PANEL_DRAG_THRESHOLD_PX) {
          return;
        }

        if (!currentDrag.isDragging) {
          currentDrag.isDragging = true;
          onDragStart(currentDrag.panelId);
        }

        pointerEvent.preventDefault();
        emitDockPanelDragEvent(DOCK_PANEL_DRAG_MOVE_EVENT, {
          panelId: currentDrag.panelId,
          clientX: pointerEvent.clientX,
          clientY: pointerEvent.clientY,
        });
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        const currentDrag = pendingPanelDragRef.current;
        if (!currentDrag || currentDrag.pointerId !== pointerEvent.pointerId) {
          return;
        }

        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        document.removeEventListener('pointercancel', handlePointerUp);
        pendingPanelDragRef.current = null;

        if (!currentDrag.isDragging) {
          return;
        }

        pointerEvent.preventDefault();
        emitDockPanelDragEvent(
          pointerEvent.type === 'pointercancel'
            ? DOCK_PANEL_DRAG_CANCEL_EVENT
            : DOCK_PANEL_DRAG_END_EVENT,
          {
            panelId: currentDrag.panelId,
            clientX: pointerEvent.clientX,
            clientY: pointerEvent.clientY,
          },
        );
        onDragEnd();
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
      document.addEventListener('pointercancel', handlePointerUp);
    },
    [onDragEnd, onDragStart],
  );

  if (panelIds.length === 0) {
    // Empty zone — only show as drop target when dragging
    if (!isDragging) return <></>;
    return (
      <div
        ref={rootRef}
        data-testid={`dock-zone-${zoneId}-empty`}
        data-dock-zone-id={zoneId}
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
  const isHorizontalCollapsed = collapsed && collapseDirection === 'horizontal';
  const tabBarClasses = isHorizontalCollapsed
    ? 'flex h-full w-full shrink-0 flex-col items-center justify-between border-b-0 px-1 py-1'
    : 'flex h-8 shrink-0 items-center justify-between border-b border-editor-border px-1';
  const tabListClasses = isHorizontalCollapsed
    ? 'flex min-h-0 flex-col items-center gap-1 overflow-y-auto'
    : 'flex min-w-0 items-center gap-0.5 overflow-x-auto';
  const actionClasses = isHorizontalCollapsed
    ? 'flex shrink-0 flex-col items-center gap-1'
    : 'flex shrink-0 items-center gap-1';
  const shouldRenderActivePanel =
    activePanelId !== null && (!collapsed || keepMountedPanelIds.includes(activePanelId));

  return (
    <div
      ref={rootRef}
      data-testid={`dock-zone-${zoneId}`}
      data-dock-zone-id={zoneId}
      className={`flex flex-col overflow-hidden bg-editor-sidebar ${dropHighlight} transition-shadow ${className}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Tab bar */}
      {showTabs && (
        <div className={tabBarClasses}>
          <div
            className={tabListClasses}
            role="tablist"
            aria-label={`${zoneId} panels`}
            aria-orientation={isHorizontalCollapsed ? 'vertical' : 'horizontal'}
          >
            {panelIds.map((panelId) => {
              const meta = PANEL_REGISTRY[panelId];
              const PanelIcon = PANEL_ICONS[panelId];
              const isActive = activePanelId === panelId && !collapsed;
              const isDraggable = panelId !== 'terminal';
              return (
                <button
                  key={panelId}
                  draggable={false}
                  onDragStart={isDraggable ? (e) => handleTabDragStart(e, panelId) : undefined}
                  onDragEnd={handleTabDragEnd}
                  onPointerDown={
                    isDraggable ? (event) => handleTabPointerDown(event, panelId) : undefined
                  }
                  onClick={() => onTabClick(panelId)}
                  className={`flex shrink-0 items-center gap-1 text-xs font-medium transition-colors ${
                    isHorizontalCollapsed
                      ? `h-7 w-7 justify-center rounded ${
                          isActive
                            ? 'bg-editor-bg text-editor-text'
                            : 'text-editor-text-muted hover:bg-editor-border/50 hover:text-editor-text'
                        }`
                      : `rounded-t px-2 py-1 ${
                          isActive
                            ? 'bg-editor-bg text-editor-text'
                            : 'text-editor-text-muted hover:text-editor-text hover:bg-editor-border/50'
                        }`
                  }`}
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`dock-panel-${panelId}`}
                  aria-label={isHorizontalCollapsed ? meta.label : undefined}
                  title={isDraggable ? `${meta.label} (drag to move)` : meta.label}
                >
                  {isHorizontalCollapsed ? (
                    <PanelIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <>
                      {isDraggable && <GripVertical className="w-3 h-3 opacity-40" />}
                      <span className="whitespace-nowrap">{meta.label}</span>
                    </>
                  )}
                </button>
              );
            })}
          </div>
          <div className={actionClasses}>
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
      {shouldRenderActivePanel && (
        <div
          id={`dock-panel-${activePanelId}`}
          role="tabpanel"
          className={
            collapsed
              ? 'hidden'
              : 'min-h-0 flex-1 overflow-hidden bg-editor-bg'
          }
          aria-hidden={collapsed ? true : undefined}
        >
          {renderPanel(activePanelId)}
        </div>
      )}
    </div>
  );
}

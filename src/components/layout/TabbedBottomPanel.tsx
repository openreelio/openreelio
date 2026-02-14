/**
 * TabbedBottomPanel Component
 *
 * A collapsible bottom panel with multiple tabs for console, mixer, and other content.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface BottomPanelTab {
  /** Unique tab ID */
  id: string;
  /** Tab display label */
  label: string;
  /** Tab icon (optional) */
  icon?: ReactNode;
  /** Tab content */
  content: ReactNode;
}

export interface TabbedBottomPanelProps {
  /** Array of tabs */
  tabs: BottomPanelTab[];
  /** Initial active tab ID */
  defaultTab?: string;
  /** Default height in pixels */
  defaultHeight?: number;
  /** Start collapsed */
  defaultCollapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapse?: (collapsed: boolean) => void;
  /** Callback when active tab changes */
  onTabChange?: (tabId: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_HEIGHT = 160;
const COLLAPSED_HEIGHT = 32;

// =============================================================================
// Component
// =============================================================================

export function TabbedBottomPanel({
  tabs,
  defaultTab,
  defaultHeight = DEFAULT_HEIGHT,
  defaultCollapsed = false,
  onCollapse,
  onTabChange,
}: TabbedBottomPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [activeTabId, setActiveTabId] = useState(defaultTab ?? tabs[0]?.id ?? '');

  useEffect(() => {
    if (tabs.length === 0) {
      setActiveTabId('');
      return;
    }

    const hasActiveTab = tabs.some((tab) => tab.id === activeTabId);
    if (!hasActiveTab) {
      setActiveTabId(defaultTab ?? tabs[0].id);
    }
  }, [activeTabId, defaultTab, tabs]);

  const handleToggle = () => {
    const newCollapsed = !isCollapsed;
    setIsCollapsed(newCollapsed);
    onCollapse?.(newCollapsed);
  };

  const handleTabClick = (tabId: string) => {
    // If clicking active tab while expanded, collapse
    if (tabId === activeTabId && !isCollapsed) {
      setIsCollapsed(true);
      onCollapse?.(true);
      return;
    }

    // Otherwise, select tab and expand
    setActiveTabId(tabId);
    onTabChange?.(tabId);

    if (isCollapsed) {
      setIsCollapsed(false);
      onCollapse?.(false);
    }
  };

  const height = isCollapsed ? COLLAPSED_HEIGHT : defaultHeight;
  const CollapseIcon = isCollapsed ? ChevronUp : ChevronDown;
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeTabPanelId = activeTab ? `bottom-panel-tab-${activeTab.id}` : undefined;

  return (
    <div
      data-testid="tabbed-bottom-panel"
      className="flex flex-col border-t border-editor-border bg-editor-sidebar transition-all duration-200"
      style={{ height: `${height}px` }}
    >
      {/* Header with tabs and toggle */}
      <div className="flex h-8 items-center justify-between border-b border-editor-border px-2">
        {/* Tabs */}
        <div
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Bottom panel tabs"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id)}
              className={`
                flex shrink-0 items-center gap-1.5 rounded-t px-3 py-1 text-xs font-medium
                transition-colors
                ${
                  activeTabId === tab.id && !isCollapsed
                    ? 'bg-editor-bg text-editor-text border-t border-x border-editor-border -mb-px'
                    : 'text-editor-text-muted hover:text-editor-text hover:bg-editor-border/50'
                }
              `}
              id={`bottom-panel-tab-button-${tab.id}`}
              aria-controls={`bottom-panel-tab-${tab.id}`}
              aria-selected={activeTabId === tab.id}
              role="tab"
            >
              {tab.icon}
              <span className="whitespace-nowrap">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Collapse toggle */}
        <button
          onClick={handleToggle}
          className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text transition-colors"
          aria-label={isCollapsed ? 'Expand panel' : 'Collapse panel'}
        >
          <CollapseIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      {!isCollapsed && activeTab && (
        <div
          id={activeTabPanelId}
          role="tabpanel"
          aria-labelledby={`bottom-panel-tab-button-${activeTab.id}`}
          className="flex-1 overflow-auto bg-editor-bg"
          style={{ height: `${height - COLLAPSED_HEIGHT}px` }}
        >
          {activeTab.content}
        </div>
      )}

      {!isCollapsed && !activeTab && (
        <div className="flex flex-1 items-center justify-center bg-editor-bg text-xs text-editor-text-muted">
          No panel tabs available.
        </div>
      )}
    </div>
  );
}

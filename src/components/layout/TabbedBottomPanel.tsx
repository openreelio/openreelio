/**
 * TabbedBottomPanel Component
 *
 * A collapsible bottom panel with multiple tabs for console, mixer, and other content.
 */

import { useState, type ReactNode } from 'react';
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

  return (
    <div
      data-testid="tabbed-bottom-panel"
      className="bg-editor-sidebar border-t border-editor-border transition-all duration-200"
      style={{ height: `${height}px` }}
    >
      {/* Header with tabs and toggle */}
      <div className="h-8 flex items-center justify-between px-2 border-b border-editor-border">
        {/* Tabs */}
        <div className="flex items-center gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab.id)}
              className={`
                flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-t
                transition-colors
                ${
                  activeTabId === tab.id && !isCollapsed
                    ? 'bg-editor-bg text-editor-text border-t border-x border-editor-border -mb-px'
                    : 'text-editor-text-muted hover:text-editor-text hover:bg-editor-border/50'
                }
              `}
              aria-selected={activeTabId === tab.id}
              role="tab"
            >
              {tab.icon}
              <span>{tab.label}</span>
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
          className="overflow-auto bg-editor-bg"
          style={{ height: `${height - COLLAPSED_HEIGHT}px` }}
        >
          {activeTab.content}
        </div>
      )}
    </div>
  );
}

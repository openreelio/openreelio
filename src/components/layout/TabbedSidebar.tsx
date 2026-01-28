/**
 * TabbedSidebar Component
 *
 * A sidebar with tabbed content switching.
 * Extends the base Sidebar component with tab navigation.
 */

import { useState, useCallback, memo, type ReactNode } from 'react';
import { Tabs, type Tab } from '@/components/ui/Tabs';

// =============================================================================
// Types
// =============================================================================

export interface TabbedSidebarTab {
  /** Unique identifier for the tab */
  id: string;
  /** Display label for the tab */
  label: string;
  /** Optional icon to display in tab */
  icon?: ReactNode;
  /** Content component to render when tab is active */
  content: ReactNode;
  /** Whether the tab is disabled */
  disabled?: boolean;
}

export interface TabbedSidebarProps {
  /** Array of tab definitions */
  tabs: TabbedSidebarTab[];
  /** Sidebar position */
  position?: 'left' | 'right';
  /** Initial width in pixels */
  width?: number;
  /** Minimum width when resizing */
  minWidth?: number;
  /** Maximum width when resizing */
  maxWidth?: number;
  /** Whether sidebar starts collapsed */
  defaultCollapsed?: boolean;
  /** Initial active tab ID */
  defaultActiveTab?: string;
  /** Additional CSS classes */
  className?: string;
  /** Callback when collapsed state changes */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Callback when active tab changes */
  onActiveTabChange?: (tabId: string) => void;
}

// =============================================================================
// Icons
// =============================================================================

function CollapseLeftIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M11 19l-7-7 7-7m8 14V5"
      />
    </svg>
  );
}

function CollapseRightIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5v14" />
    </svg>
  );
}

function ExpandIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6h16M4 12h16M4 18h16"
      />
    </svg>
  );
}

// =============================================================================
// Component
// =============================================================================

export const TabbedSidebar = memo(function TabbedSidebar({
  tabs,
  position = 'left',
  width = 280,
  minWidth: _minWidth = 200,
  maxWidth: _maxWidth = 500,
  defaultCollapsed = false,
  defaultActiveTab,
  className = '',
  onCollapsedChange,
  onActiveTabChange,
}: TabbedSidebarProps) {
  // Placeholder: minWidth/maxWidth will be used when sidebar resize is implemented
  void _minWidth;
  void _maxWidth;
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [activeTabId, setActiveTabId] = useState(
    defaultActiveTab || (tabs.length > 0 ? tabs[0].id : ''),
  );

  // Handle collapse toggle
  const handleCollapseToggle = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      onCollapsedChange?.(next);
      return next;
    });
  }, [onCollapsedChange]);

  // Handle active tab change
  const handleActiveTabChange = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      onActiveTabChange?.(tabId);
    },
    [onActiveTabChange],
  );

  // Get active tab for collapsed view
  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Convert tabs to Tabs component format
  const tabsForComponent: Tab[] = tabs.map((tab) => ({
    id: tab.id,
    label: tab.label,
    icon: tab.icon,
    content: tab.content,
    disabled: tab.disabled,
  }));

  // Collapsed view - show only icons with expand button
  if (isCollapsed) {
    return (
      <div
        className={`flex flex-col bg-editor-bg border-editor-border h-full ${
          position === 'left' ? 'border-r' : 'border-l'
        } ${className}`}
        style={{ width: 48 }}
        data-testid="tabbed-sidebar"
        data-collapsed="true"
      >
        {/* Expand button */}
        <button
          type="button"
          className="p-3 hover:bg-editor-hover transition-colors text-editor-text-muted hover:text-editor-text"
          onClick={handleCollapseToggle}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <ExpandIcon />
        </button>

        {/* Vertical tab icons */}
        <div className="flex flex-col items-center gap-1 py-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`p-2 rounded transition-colors ${
                tab.id === activeTabId
                  ? 'bg-primary-500/20 text-primary-500'
                  : 'text-editor-text-muted hover:text-editor-text hover:bg-editor-hover'
              } ${tab.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              onClick={() => {
                if (!tab.disabled) {
                  handleActiveTabChange(tab.id);
                  // Expand when clicking a tab in collapsed mode
                  handleCollapseToggle();
                }
              }}
              title={tab.label}
              aria-label={tab.label}
              disabled={tab.disabled}
            >
              {tab.icon || (
                <span className="w-4 h-4 flex items-center justify-center text-xs font-medium">
                  {tab.label.charAt(0)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Expanded view - full tabs with content
  return (
    <div
      className={`flex flex-col bg-editor-bg border-editor-border h-full ${
        position === 'left' ? 'border-r' : 'border-l'
      } ${className}`}
      style={{ width }}
      data-testid="tabbed-sidebar"
      data-collapsed="false"
    >
      {/* Header with collapse button */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-editor-border">
        <span className="text-xs font-medium text-editor-text-muted uppercase tracking-wider">
          {activeTab?.label || 'Sidebar'}
        </span>
        <button
          type="button"
          className="p-1 hover:bg-editor-hover rounded transition-colors text-editor-text-muted hover:text-editor-text"
          onClick={handleCollapseToggle}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          {position === 'left' ? <CollapseLeftIcon /> : <CollapseRightIcon />}
        </button>
      </div>

      {/* Tabs */}
      <Tabs
        tabs={tabsForComponent}
        activeId={activeTabId}
        onActiveChange={handleActiveTabChange}
        className="flex-1 overflow-hidden"
        tabBarClassName="bg-editor-bg px-1"
        contentClassName="bg-editor-bg"
        iconOnly={false}
      />
    </div>
  );
});

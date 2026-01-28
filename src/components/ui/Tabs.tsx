/**
 * Tabs Component
 *
 * A reusable tabs component with keyboard navigation support.
 * Renders a tab bar and content panels.
 */

import { useState, useCallback, useRef, memo, type ReactNode, type KeyboardEvent } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface Tab {
  /** Unique identifier for the tab */
  id: string;
  /** Display label for the tab */
  label: string;
  /** Optional icon to display before label */
  icon?: ReactNode;
  /** Content to render when tab is active */
  content: ReactNode;
  /** Whether the tab is disabled */
  disabled?: boolean;
}

export interface TabsProps {
  /** Array of tab definitions */
  tabs: Tab[];
  /** Initially active tab ID (defaults to first tab) */
  defaultActiveId?: string;
  /** Controlled active tab ID */
  activeId?: string;
  /** Callback when active tab changes */
  onActiveChange?: (tabId: string) => void;
  /** Tab bar position */
  position?: 'top' | 'bottom';
  /** Additional CSS classes for container */
  className?: string;
  /** Additional CSS classes for tab bar */
  tabBarClassName?: string;
  /** Additional CSS classes for content area */
  contentClassName?: string;
  /** Whether to show only icons in tabs (for compact mode) */
  iconOnly?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export const Tabs = memo(function Tabs({
  tabs,
  defaultActiveId,
  activeId: controlledActiveId,
  onActiveChange,
  position = 'top',
  className = '',
  tabBarClassName = '',
  contentClassName = '',
  iconOnly = false,
}: TabsProps) {
  // Internal state for uncontrolled mode
  const [internalActiveId, setInternalActiveId] = useState(
    defaultActiveId || (tabs.length > 0 ? tabs[0].id : ''),
  );

  // Use controlled or internal state
  const activeId = controlledActiveId ?? internalActiveId;

  // Tab refs for keyboard navigation
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Handle tab click
  const handleTabClick = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.disabled) return;

      if (controlledActiveId === undefined) {
        setInternalActiveId(tabId);
      }
      onActiveChange?.(tabId);
    },
    [tabs, controlledActiveId, onActiveChange],
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const enabledTabs = tabs.filter((t) => !t.disabled);
      const currentIndex = enabledTabs.findIndex((t) => t.id === activeId);

      let nextIndex: number | null = null;

      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          nextIndex = currentIndex > 0 ? currentIndex - 1 : enabledTabs.length - 1;
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          nextIndex = currentIndex < enabledTabs.length - 1 ? currentIndex + 1 : 0;
          break;
        case 'Home':
          event.preventDefault();
          nextIndex = 0;
          break;
        case 'End':
          event.preventDefault();
          nextIndex = enabledTabs.length - 1;
          break;
      }

      if (nextIndex !== null && enabledTabs[nextIndex]) {
        const nextTabId = enabledTabs[nextIndex].id;
        handleTabClick(nextTabId);
        tabRefs.current.get(nextTabId)?.focus();
      }
    },
    [tabs, activeId, handleTabClick],
  );

  // Find active tab content
  const activeTab = tabs.find((t) => t.id === activeId);

  // Render tab bar
  const tabBar = (
    <div
      role="tablist"
      aria-orientation="horizontal"
      className={`flex border-editor-border ${
        position === 'top' ? 'border-b' : 'border-t'
      } ${tabBarClassName}`}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const isDisabled = tab.disabled;

        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) {
                tabRefs.current.set(tab.id, el);
              } else {
                tabRefs.current.delete(tab.id);
              }
            }}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            aria-disabled={isDisabled}
            tabIndex={isActive ? 0 : -1}
            disabled={isDisabled}
            className={`
              flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors
              ${
                isActive
                  ? 'text-editor-text border-b-2 border-primary-500 -mb-px'
                  : 'text-editor-text-muted hover:text-editor-text hover:bg-editor-hover'
              }
              ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
            onClick={() => handleTabClick(tab.id)}
          >
            {tab.icon && <span className="w-4 h-4">{tab.icon}</span>}
            {!iconOnly && <span>{tab.label}</span>}
          </button>
        );
      })}
    </div>
  );

  // Render content
  const content = (
    <div
      role="tabpanel"
      id={`tabpanel-${activeId}`}
      aria-labelledby={`tab-${activeId}`}
      className={`flex-1 overflow-auto ${contentClassName}`}
    >
      {activeTab?.content}
    </div>
  );

  return (
    <div className={`flex flex-col h-full ${className}`} data-testid="tabs">
      {position === 'top' ? (
        <>
          {tabBar}
          {content}
        </>
      ) : (
        <>
          {content}
          {tabBar}
        </>
      )}
    </div>
  );
});

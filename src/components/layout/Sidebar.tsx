/**
 * Sidebar Component
 *
 * A collapsible sidebar for the application layout.
 * Can be positioned on the left or right side.
 */

import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

type SidebarPosition = 'left' | 'right';

interface SidebarProps {
  /** Sidebar title */
  title: string;
  /** Sidebar children */
  children: ReactNode;
  /** Position (left or right) */
  position?: SidebarPosition;
  /** Custom width in pixels */
  width?: number;
  /** Start collapsed */
  defaultCollapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapse?: (collapsed: boolean) => void;
}

// =============================================================================
// Constants
// =============================================================================

const COLLAPSED_WIDTH_CLASS = 'w-10';
const EXPANDED_WIDTH_CLASS = 'w-64';

// =============================================================================
// Component
// =============================================================================

export function Sidebar({
  title,
  children,
  position = 'left',
  width,
  defaultCollapsed = false,
  onCollapse,
}: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const handleToggle = () => {
    const newCollapsed = !isCollapsed;
    setIsCollapsed(newCollapsed);
    onCollapse?.(newCollapsed);
  };

  const borderClass = position === 'left' ? 'border-r' : 'border-l';
  const widthClass = isCollapsed ? COLLAPSED_WIDTH_CLASS : EXPANDED_WIDTH_CLASS;
  const widthStyle = width && !isCollapsed ? { width: `${width}px` } : undefined;

  const CollapseIcon = position === 'left'
    ? (isCollapsed ? ChevronRight : ChevronLeft)
    : (isCollapsed ? ChevronLeft : ChevronRight);

  return (
    <aside
      className={`${widthClass} bg-editor-sidebar ${borderClass} border-editor-border flex flex-col transition-all duration-200`}
      style={widthStyle}
    >
      {/* Header with title and toggle */}
      <div className="flex items-center justify-between p-2 border-b border-editor-border">
        {!isCollapsed && (
          <h2 className="text-xs font-semibold text-editor-text-muted uppercase tracking-wider px-2">
            {title}
          </h2>
        )}
        <button
          onClick={handleToggle}
          className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text transition-colors"
          aria-label={`Toggle ${title} sidebar`}
        >
          <CollapseIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="flex-1 p-4 overflow-auto">
          {children}
        </div>
      )}
    </aside>
  );
}

/**
 * Sidebar Component
 *
 * A collapsible sidebar for the application layout.
 * Can be positioned on the left or right side.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
  /** Additional container classes */
  className?: string;
  /** Auto-collapse threshold in px for narrower viewports */
  autoCollapseBreakpoint?: number;
}

// =============================================================================
// Constants
// =============================================================================

const COLLAPSED_WIDTH_CLASS = 'w-10';
const EXPANDED_WIDTH_CLASS = 'w-64';
const DEFAULT_AUTO_COLLAPSE_BREAKPOINT = 1024;

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
  className = '',
  autoCollapseBreakpoint = DEFAULT_AUTO_COLLAPSE_BREAKPOINT,
}: SidebarProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const handleToggle = useCallback(() => {
    const newCollapsed = !isCollapsed;
    setIsCollapsed(newCollapsed);
    onCollapse?.(newCollapsed);
  }, [isCollapsed, onCollapse]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleResize = () => {
      if (window.innerWidth < autoCollapseBreakpoint) {
        setIsCollapsed((current) => {
          if (current) {
            return current;
          }

          onCollapse?.(true);
          return true;
        });
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [autoCollapseBreakpoint, onCollapse]);

  const borderClass = position === 'left' ? 'border-r' : 'border-l';
  const widthClass = isCollapsed ? COLLAPSED_WIDTH_CLASS : EXPANDED_WIDTH_CLASS;
  const safeWidth = width && width > 0 ? width : undefined;
  const widthStyle = safeWidth && !isCollapsed ? { width: `${safeWidth}px` } : undefined;

  const CollapseIcon =
    position === 'left'
      ? isCollapsed
        ? ChevronRight
        : ChevronLeft
      : isCollapsed
        ? ChevronLeft
        : ChevronRight;

  return (
    <aside
      className={`${widthClass} ${borderClass} border-editor-border bg-editor-sidebar flex shrink-0 flex-col overflow-hidden transition-all duration-200 ${className}`}
      style={widthStyle}
      data-collapsed={isCollapsed}
    >
      {/* Header with title and toggle */}
      <div className="flex items-center justify-between border-b border-editor-border p-2">
        {!isCollapsed && (
          <h2 className="truncate px-2 text-xs font-semibold uppercase tracking-wider text-editor-text-muted">
            {title}
          </h2>
        )}
        <button
          onClick={handleToggle}
          className="rounded p-1 text-editor-text-muted transition-colors hover:bg-editor-border hover:text-editor-text"
          aria-label={`Toggle ${title} sidebar`}
          aria-expanded={!isCollapsed}
        >
          <CollapseIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      {!isCollapsed && <div className="flex-1 overflow-auto p-4">{children}</div>}
    </aside>
  );
}

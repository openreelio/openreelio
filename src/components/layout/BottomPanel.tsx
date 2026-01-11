/**
 * BottomPanel Component
 *
 * A collapsible bottom panel for console, jobs, and other secondary content.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

interface BottomPanelProps {
  /** Panel title */
  title: string;
  /** Panel children */
  children: ReactNode;
  /** Default height in pixels */
  defaultHeight?: number;
  /** Start collapsed */
  defaultCollapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapse?: (collapsed: boolean) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_HEIGHT = 128; // h-32 = 8rem = 128px
const COLLAPSED_HEIGHT = 32;

// =============================================================================
// Component
// =============================================================================

export function BottomPanel({
  title,
  children,
  defaultHeight = DEFAULT_HEIGHT,
  defaultCollapsed = false,
  onCollapse,
}: BottomPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const handleToggle = () => {
    const newCollapsed = !isCollapsed;
    setIsCollapsed(newCollapsed);
    onCollapse?.(newCollapsed);
  };

  const height = isCollapsed ? COLLAPSED_HEIGHT : defaultHeight;
  const CollapseIcon = isCollapsed ? ChevronUp : ChevronDown;

  return (
    <div
      className="bg-editor-sidebar border-t border-editor-border transition-all duration-200"
      style={{ height: `${height}px` }}
    >
      {/* Header with title and toggle */}
      <div className="h-8 flex items-center justify-between px-4 border-b border-editor-border">
        <h2 className="text-xs font-semibold text-editor-text-muted uppercase tracking-wider">
          {title}
        </h2>
        <button
          onClick={handleToggle}
          className="p-1 rounded hover:bg-editor-border text-editor-text-muted hover:text-editor-text transition-colors"
          aria-label={`Toggle ${title} panel`}
        >
          <CollapseIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="p-4 overflow-auto" style={{ height: `${height - COLLAPSED_HEIGHT}px` }}>
          {children}
        </div>
      )}
    </div>
  );
}

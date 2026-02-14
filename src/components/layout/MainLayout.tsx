/**
 * MainLayout Component
 *
 * The main application layout with header, sidebars, content area, and footer.
 * Uses CSS Grid/Flexbox for responsive layout.
 */

import { type ReactNode } from 'react';

// =============================================================================
// Types
// =============================================================================

interface MainLayoutProps {
  /** Header element */
  header: ReactNode;
  /** Left sidebar element (optional) */
  leftSidebar?: ReactNode;
  /** Right sidebar element (optional) */
  rightSidebar?: ReactNode;
  /** Footer element (optional) */
  footer?: ReactNode;
  /** Main content */
  children: ReactNode;
}

// =============================================================================
// Component
// =============================================================================

export function MainLayout({
  header,
  leftSidebar,
  rightSidebar,
  footer,
  children,
}: MainLayoutProps) {
  return (
    <div className="h-screen min-h-screen bg-editor-bg text-editor-text flex flex-col overflow-hidden">
      {/* Header */}
      <header role="banner" className="shrink-0">
        {header}
      </header>

      {/* Main content area with sidebars */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Sidebar */}
        {leftSidebar}

        {/* Center content */}
        <main role="main" className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>

        {/* Right Sidebar */}
        {rightSidebar}
      </div>

      {/* Footer */}
      {footer && (
        <footer role="contentinfo" className="shrink-0">
          {footer}
        </footer>
      )}
    </div>
  );
}

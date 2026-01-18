/**
 * Header Component
 *
 * Application header with branding, menu bar, and toolbar.
 */

import { UndoRedoButtons } from '@/components/ui';

// =============================================================================
// Types
// =============================================================================

interface HeaderProps {
  /** Application title */
  title?: string;
  /** Version string */
  version?: string;
  /** Whether to show toolbar (undo/redo buttons) */
  showToolbar?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function Header({
  title = 'OpenReelio',
  version = '0.1.0',
  showToolbar = true,
}: HeaderProps) {
  return (
    <div className="h-10 bg-editor-sidebar border-b border-editor-border flex items-center px-4">
      {/* Branding */}
      <h1 className="text-sm font-semibold text-primary-400">{title}</h1>
      <span className="ml-2 text-xs text-editor-text-muted">v{version}</span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Toolbar */}
      {showToolbar && (
        <div className="flex items-center gap-2">
          <UndoRedoButtons />
        </div>
      )}
    </div>
  );
}

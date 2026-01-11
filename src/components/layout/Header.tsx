/**
 * Header Component
 *
 * Application header with branding and menu bar.
 */

// =============================================================================
// Types
// =============================================================================

interface HeaderProps {
  /** Application title */
  title?: string;
  /** Version string */
  version?: string;
}

// =============================================================================
// Component
// =============================================================================

export function Header({ title = 'OpenReelio', version = '0.1.0' }: HeaderProps) {
  return (
    <div className="h-10 bg-editor-sidebar border-b border-editor-border flex items-center px-4">
      <h1 className="text-sm font-semibold text-primary-400">{title}</h1>
      <span className="ml-2 text-xs text-editor-text-muted">v{version}</span>
    </div>
  );
}

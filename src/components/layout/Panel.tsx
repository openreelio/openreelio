/**
 * Panel Component
 *
 * A generic panel wrapper with configurable styling.
 * Used as a building block for other layout components.
 */

import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

// =============================================================================
// Types
// =============================================================================

type PanelVariant = 'default' | 'sidebar' | 'dark';

interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Panel title (optional) */
  title?: string;
  /** Panel children */
  children: ReactNode;
  /** Visual variant */
  variant?: PanelVariant;
  /** Remove default padding */
  noPadding?: boolean;
  /** Add border */
  bordered?: boolean;
}

// =============================================================================
// Variant Styles
// =============================================================================

const variantStyles: Record<PanelVariant, string> = {
  default: 'bg-editor-panel',
  sidebar: 'bg-editor-sidebar',
  dark: 'bg-editor-bg',
};

// =============================================================================
// Component
// =============================================================================

export const Panel = forwardRef<HTMLDivElement, PanelProps>(
  (
    {
      title,
      children,
      variant = 'default',
      noPadding = false,
      bordered = false,
      className = '',
      ...props
    },
    ref
  ) => {
    const baseStyles = 'text-editor-text';
    const paddingStyles = noPadding ? '' : 'p-4';
    const borderStyles = bordered ? 'border border-editor-border rounded' : '';

    return (
      <div
        ref={ref}
        className={`${baseStyles} ${variantStyles[variant]} ${paddingStyles} ${borderStyles} ${className}`}
        {...props}
      >
        {title && (
          <h2 className="text-xs font-semibold text-editor-text-muted uppercase tracking-wider mb-4">
            {title}
          </h2>
        )}
        {children}
      </div>
    );
  }
);

Panel.displayName = 'Panel';

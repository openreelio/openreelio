/**
 * Spinner Component
 *
 * Loading spinner for short operations (1-3 seconds).
 */

import { Loader2 } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface SpinnerProps {
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Optional label */
  label?: string;
  /** Custom class name */
  className?: string;
}

// =============================================================================
// Size Configuration
// =============================================================================

const sizeConfig = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
};

// =============================================================================
// Spinner Component
// =============================================================================

export function Spinner({ size = 'md', label, className = '' }: SpinnerProps): JSX.Element {
  return (
    <div className={`flex items-center gap-2 ${className}`} role="status">
      <Loader2 className={`${sizeConfig[size]} animate-spin text-accent-primary`} />
      {label && <span className="text-sm text-text-secondary">{label}</span>}
      <span className="sr-only">Loading...</span>
    </div>
  );
}

// =============================================================================
// Centered Spinner (for full-page loading)
// =============================================================================

export function CenteredSpinner({ size = 'lg', label }: SpinnerProps): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full w-full gap-3">
      <Loader2 className={`${sizeConfig[size]} animate-spin text-accent-primary`} />
      {label && <span className="text-sm text-text-secondary">{label}</span>}
    </div>
  );
}

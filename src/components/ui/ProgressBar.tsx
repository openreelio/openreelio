/**
 * Progress Bar Component
 *
 * Visual progress indicator with percentage display.
 */

import { useMemo } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface ProgressBarProps {
  /** Progress value (0-100) */
  value: number;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Color variant */
  variant?: 'primary' | 'success' | 'warning' | 'error';
  /** Show percentage text */
  showPercentage?: boolean;
  /** Indeterminate state (animated) */
  indeterminate?: boolean;
  /** Custom class name */
  className?: string;
}

// =============================================================================
// Variant Configurations
// =============================================================================

const sizeConfig = {
  sm: 'h-1',
  md: 'h-2',
  lg: 'h-3',
};

const variantConfig = {
  primary: 'bg-accent-primary',
  success: 'bg-accent-success',
  warning: 'bg-accent-warning',
  error: 'bg-accent-error',
};

const variantTextConfig = {
  primary: 'text-accent-primary',
  success: 'text-accent-success',
  warning: 'text-accent-warning',
  error: 'text-accent-error',
};

// =============================================================================
// Progress Bar Component
// =============================================================================

export function ProgressBar({
  value,
  size = 'md',
  variant = 'primary',
  showPercentage = false,
  indeterminate = false,
  className = '',
}: ProgressBarProps): JSX.Element {
  const clampedValue = useMemo(() => Math.min(100, Math.max(0, value)), [value]);

  return (
    <div className={`w-full ${className}`}>
      {showPercentage && (
        <div className="flex justify-between items-center mb-1">
          <span className="text-sm text-text-secondary">Progress</span>
          <span className="text-sm text-text-primary font-medium">
            {clampedValue.toFixed(0)}%
          </span>
        </div>
      )}

      <div className={`w-full bg-surface-elevated rounded-full overflow-hidden ${sizeConfig[size]}`}>
        {indeterminate ? (
          <div
            className={`h-full ${variantConfig[variant]} ${variantTextConfig[variant]} animate-shimmer`}
            style={{
              backgroundImage: `linear-gradient(90deg, transparent 0%, currentColor 50%, transparent 100%)`,
              backgroundSize: '200% 100%',
            }}
          />
        ) : (
          <div
            className={`h-full ${variantConfig[variant]} transition-all duration-normal`}
            style={{ width: `${clampedValue}%` }}
          />
        )}
      </div>
    </div>
  );
}
